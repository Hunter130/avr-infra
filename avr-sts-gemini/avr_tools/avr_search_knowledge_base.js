const axios = require("axios");

module.exports = {
  name: "avr_search_knowledge_base",
  description: "Searches the official internal knowledge base, manuals, policies, and objection handling guidelines. Use this tool when the customer presents objections, asks questions about company policies, rules, procedures, work hours, or any internal guidelines.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query or objection from the customer to look up in the knowledge base."
      }
    },
    required: ["query"]
  },
  handler: async (uuid, { query }, context) => {
    const agentId = context?.agentId || "";
    const storeNames = context?.fileSearchStoreNames || null;
    const endpoint = process.env.KNOWLEDGE_BASE_ENDPOINT_URL || "";

    console.log(`[avr_search_knowledge_base] Executing RAG search via Function Calling. Query: "${query}", AgentId: ${agentId}, StoreNames:`, storeNames);

    if (!endpoint) {
      console.error("[avr_search_knowledge_base] Error: KNOWLEDGE_BASE_ENDPOINT_URL is not defined in the environment.");
      return "Lo siento, la base de conocimientos no está configurada correctamente en el servidor.";
    }

    try {
      const response = await axios.post(endpoint, {
        query,
        agentId,
        fileSearchStoreNames: storeNames
      }, {
        headers: {
          "Content-Type": "application/json",
          "X-AVR-UUID": uuid
        },
        timeout: 4000 // 4-second timeout limit to avoid blocking the voice session
      });

      if (response.data && response.data.result) {
        console.log(`[avr_search_knowledge_base] Search successful. Response length: ${response.data.result.length}`);
        return response.data.result;
      }

      console.warn("[avr_search_knowledge_base] Warning: Endpoint did not return a 'result' field in response data.", response.data);
      return typeof response.data === "object" ? JSON.stringify(response.data) : String(response.data);
    } catch (err) {
      console.error(`[avr_search_knowledge_base] Error querying knowledge base endpoint: ${err.message}`);
      return "Lo siento, no pude obtener respuesta de la base de conocimientos en este momento.";
    }
  }
};
