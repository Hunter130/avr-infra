const fs = require('fs');
const path = require('path');
const axios = require('axios');

let supabaseToolsCache = new Map();

/**
 * Loads all available tools from both avr_tools, tools directories, and Supabase
 * @param {Array<string>} allowedToolsIds - Array of allowed tool UUIDs for the agent
 * @returns {Array} List of all available tools
 */
async function loadTools(allowedToolsIds = []) {
  // Define tool directory paths
  const avrToolsDir = path.join(__dirname, 'avr_tools');  // Project-provided tools
  const toolsDir = path.join(__dirname, 'tools');         // User custom tools
  
  let allTools = [];
  
  // Helper function to load tools from a directory
  // Gemini 3.1 requires parameters to have at least {type: "object", properties: {}}
  // An empty {} will cause: "model output must contain either output text or tool calls"
  const sanitizeParameters = (params) => {
    if (!params || typeof params !== 'object' || Object.keys(params).length === 0) {
      return { type: "object", properties: {} };
    }
    return params;
  };

  const loadToolsFromDir = (dirPath) => {
    if (!fs.existsSync(dirPath)) return [];
    
    return fs.readdirSync(dirPath)
      .map(file => {
        const tool = require(path.join(dirPath, file));
        return {
          name: tool.name,
          description: tool.description || '',
          parameters: sanitizeParameters(tool.input_schema),
        };
      });
  };

  // Load tools from both directories
  allTools = [
    ...loadToolsFromDir(avrToolsDir),  // Project tools
    ...loadToolsFromDir(toolsDir)      // Custom tools
  ];

  // Fetch tools from Supabase
  if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
    try {
      const res = await axios.get(`${process.env.SUPABASE_URL}/rest/v1/voice_agents_tools`, {
        headers: {
          apikey: process.env.SUPABASE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_KEY}`
        }
      });
      
      const supabaseTools = res.data;
      if (supabaseTools && Array.isArray(supabaseTools)) {
        for (const st of supabaseTools) {
          if (st.schema && st.name) {
            // Inject summary parameter into transfer tools automatically
            if (st.type === 'transfer' && st.schema.parameters && st.schema.parameters.properties) {
              st.schema.parameters.properties.summary = {
                type: "string",
                description: "Resumen detallado de la conversación para la transferencia cálida (warm transfer)."
              };
            }
            // Always cache the tool to allow handler resolution
            supabaseToolsCache.set(st.name, st);
            
            // Only add to allTools if the agent is allowed to use it
            if (allowedToolsIds && allowedToolsIds.includes(st.id)) {
              // Sanitize Supabase tool schema parameters too
              const sanitizedSchema = {
                ...st.schema,
                parameters: sanitizeParameters(st.schema?.parameters)
              };
              allTools.push(sanitizedSchema);
            }
          }
        }
      }
    } catch (err) {
      console.error("Error loading tools from Supabase:", err.message);
    }
  }

  // Warning if no tools found
  if (allTools.length === 0) {
    console.warn(`No tools found in ${avrToolsDir} or ${toolsDir} or Supabase`);
  }

  return allTools;
}

/**
 * Gets the handler for a specific tool
 * @param {string} name - Name of the tool
 * @returns {Function} Tool handler
 * @throws {Error} If the tool is not found
 */
function getToolHandler(name) {
  // Check if it's a Supabase tool
  if (supabaseToolsCache.has(name)) {
    const toolConfig = supabaseToolsCache.get(name);
    return async (sessionUuid, args, context) => {
      try {
        if (toolConfig.type === 'transfer') {
          console.log(`Executing Supabase tool: ${name} as TRANSFER to ${toolConfig.config.target_number}`);
          const amiUrl = process.env.AMI_URL || "http://127.0.0.1:6006";
          
          let transferContext = toolConfig.config.transfer_context || "demo";
          const isWarmTransfer = toolConfig.config.warm_transfer === true || toolConfig.config.transfer_warm === true || args.warm_transfer === true || args.transfer_warm === true;
          
          if (isWarmTransfer) {
            console.log("Warm transfer requested. Generating summary TTS...");
            const summaryText = args.summary || "Transferencia cálida sin resumen proveído.";
            try {
              const dgUrl = "https://api.deepgram.com/v1/speak?model=aura-2-estrella-es&encoding=linear16&sample_rate=8000&container=wav";
              const ttsRes = await axios.post(dgUrl, { text: summaryText }, {
                headers: {
                  'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`,
                  'Content-Type': 'application/json'
                },
                responseType: 'arraybuffer'
              });
              const fs = require('fs');
              const path = require('path');
              const filePath = path.join(__dirname, 'recordings', `whisper_${sessionUuid}.wav`);
              fs.writeFileSync(filePath, ttsRes.data);
              console.log(`TTS summary saved to ${filePath}`);
              transferContext = "warm-transfer";
            } catch (err) {
              console.error("Failed to generate TTS summary for warm transfer:", err.message);
              // Fallback to blind transfer if TTS fails
            }
          }

          const payload = {
            uuid: sessionUuid,
            exten: toolConfig.config.target_number,
            context: transferContext,
            priority: toolConfig.config.transfer_priority || 1,
            ...args
          };
          const response = await axios.post(`${amiUrl}/transfer`, payload);
          return typeof response.data === 'object' ? JSON.stringify(response.data) : String(response.data);
        }

        let url = toolConfig.config.url || "";
        const resolvedCustomerNumber = context?.customerNumber || args?.customerNumber || '';
        const resolvedAgentId = context?.agentId || args?.assistantId || args?.agentId || '';

        url = url.replace(/\{\{customer\.number\}\}/g, resolvedCustomerNumber)
                 .replace(/\{\{customerNumber\}\}/g, resolvedCustomerNumber)
                 .replace(/\{\{customer_number\}\}/g, resolvedCustomerNumber)
                 .replace(/\{\{assistant\.id\}\}/g, resolvedAgentId)
                 .replace(/\{\{assistantId\}\}/g, resolvedAgentId)
                 .replace(/\{\{agent_id\}\}/g, resolvedAgentId)
                 .replace(/\{\{agentId\}\}/g, resolvedAgentId);

        console.log(`Executing Supabase tool: ${name} with resolved URL: ${url}`);
        const response = await axios({
          method: toolConfig.config.method || 'POST',
          url: url,
          data: args,
          headers: {
            'Content-Type': 'application/json',
            'X-AVR-UUID': sessionUuid
          }
        });
        return typeof response.data === 'object' ? JSON.stringify(response.data) : String(response.data);
      } catch (err) {
        console.error(`Error executing Supabase tool ${name}:`, err.message);
        return `Error executing tool: ${err.message}`;
      }
    };
  }

  // Possible paths for the tool file
  const possiblePaths = [
    path.join(__dirname, 'avr_tools', `${name}.js`),  // First check in avr_tools
    path.join(__dirname, 'tools', `${name}.js`)       // Then check in tools
  ];

  // Find the first valid path
  const toolPath = possiblePaths.find(path => fs.existsSync(path));
  
  if (!toolPath) {
    throw new Error(`Tool "${name}" not found in any available directory or Supabase cache`);
  }

  const tool = require(toolPath);
  return tool.handler;
}

module.exports = { loadTools, getToolHandler };