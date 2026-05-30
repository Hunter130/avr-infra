const fs = require("fs");
const path = require("path");
const axios = require("axios");

// In-memory cache to ensure sub-millisecond search latencies during active calls
const dbCache = new Map();
const localCache = { documents: [], timestamp: 0 };
const CACHE_TTL_MS = 5 * 60 * 1000; // 5-minute cache lifespan

const KNOWLEDGE_BASE_DIR = path.join(__dirname, "..", "knowledge_base");

/**
 * Normalizes text to improve token match accuracy (removes accents, punctuation, stopwords, downcases).
 * @param {string} text - Text to normalize
 * @returns {string[]} Normalized words/tokens
 */
function tokenizeAndNormalize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Remove accents/diacritics
    .replace(/[^a-z0-9\s]/g, " ")     // Strip special characters
    .split(/\s+/)
    .filter(word => word.length > 2); // Exclude very short connector words
}

/**
 * Performs a fast paragraph-level search on the provided document list.
 * Splits documents into paragraphs to return only the most relevant context,
 * which keeps Gemini's token consumption low and minimizes latency.
 * 
 * @param {Array<{title: string, content: string}>} docs - List of documents
 * @param {string} query - The search query
 * @returns {string} Formatted search result
 */
function searchDocuments(docs, query) {
  if (!docs || docs.length === 0) {
    return "No se encontraron políticas ni manuales de apoyo disponibles en el sistema.";
  }

  const queryTokens = tokenizeAndNormalize(query);
  if (queryTokens.length === 0) {
    const titles = docs.map(d => `- ${d.title}`).join("\n");
    return `Consulta vacía. Documentos de apoyo disponibles:\n${titles}`;
  }

  const matches = [];

  for (const doc of docs) {
    const titleTokens = tokenizeAndNormalize(doc.title);
    
    // Assign higher weight if query tokens match the document title (stem/substring check)
    let titleScore = 0;
    for (const qToken of queryTokens) {
      if (titleTokens.some(tToken => tToken.includes(qToken) || qToken.includes(tToken))) {
        titleScore += 3.5; // Title match bonus
      }
    }

    // Split document into paragraphs/chunks
    const paragraphs = doc.content.split(/\n\s*\n+/);

    for (const paragraph of paragraphs) {
      const trimmed = paragraph.trim();
      if (!trimmed || trimmed.length < 10) continue;

      const paragraphTokens = tokenizeAndNormalize(trimmed);
      let paragraphScore = 0;

      for (const qToken of queryTokens) {
        if (paragraphTokens.some(pToken => pToken.includes(qToken) || qToken.includes(pToken))) {
          paragraphScore += 1.0;
        }
      }

      const totalScore = paragraphScore + titleScore;
      if (totalScore > 0) {
        matches.push({
          title: doc.title,
          content: trimmed,
          score: totalScore
        });
      }
    }
  }

  if (matches.length === 0) {
    // If no specific match was found, return a polite notice with available docs
    const titles = docs.map(d => `- ${d.title}`).join("\n");
    return `No se encontró información relevante sobre "${query}". Documentos de apoyo disponibles:\n${titles}`;
  }

  // Sort matches by relevance score in descending order
  matches.sort((a, b) => b.score - a.score);

  // Return the top 2 matches to keep context compact
  const topMatches = matches.slice(0, 2);
  let responseText = "Información relevante encontrada en los documentos de apoyo:\n\n";
  for (const match of topMatches) {
    responseText += `[Documento: ${match.title}]\n"${match.content}"\n\n`;
  }

  return responseText.trim();
}

/**
 * Loads documents from the local 'knowledge_base' directory.
 * Writes default files if the directory is empty, ensuring a self-contained local experience.
 */
function loadLocalDocuments() {
  const now = Date.now();
  if (localCache.documents.length > 0 && (now - localCache.timestamp < CACHE_TTL_MS)) {
    return localCache.documents;
  }

  try {
    if (!fs.existsSync(KNOWLEDGE_BASE_DIR)) {
      fs.mkdirSync(KNOWLEDGE_BASE_DIR, { recursive: true });
    }

    const files = fs.readdirSync(KNOWLEDGE_BASE_DIR);
    
    // Create mock files for testing if directory is empty
    if (files.length === 0) {
      const defaultDocs = [
        {
          name: "Politicas_de_Devolucion.txt",
          content: "Políticas de Devolución:\n- Las devoluciones se aceptan dentro de los 30 días posteriores a la compra.\n- El producto debe estar sellado y en su empaque original.\n- Los reembolsos demoran de 5 a 7 días hábiles en verse reflejados en la tarjeta original."
        },
        {
          name: "Preguntas_Frecuentes_y_Horarios.txt",
          content: "Horarios y Ubicaciones:\n- Nuestro horario de atención al cliente es de lunes a viernes de 9:00 AM a 6:00 PM (hora CDMX).\n- Contamos con sucursales físicas en Ciudad de México, Monterrey y Guadalajara.\n- Para soporte técnico, el horario es extendido de 8:00 AM a 10:00 PM."
        }
      ];
      for (const d of defaultDocs) {
        fs.writeFileSync(path.join(KNOWLEDGE_BASE_DIR, d.name), d.content);
      }
      files.push(...defaultDocs.map(d => d.name));
    }

    const docs = [];
    for (const file of files) {
      if (file.endsWith(".txt") || file.endsWith(".md")) {
        const filePath = path.join(KNOWLEDGE_BASE_DIR, file);
        const content = fs.readFileSync(filePath, "utf8");
        const title = path.parse(file).name.replace(/_/g, " ");
        docs.push({ title, content });
      }
    }

    localCache.documents = docs;
    localCache.timestamp = now;
    console.log(`[avr_search_knowledge_base] Loaded ${docs.length} local files to cache.`);
  } catch (err) {
    console.error("[avr_search_knowledge_base] Error reading local knowledge directory:", err.message);
  }

  return localCache.documents;
}

/**
 * Fetches documents from Supabase's voice_agents_knowledge table.
 * If database is unavailable, it returns null to trigger local fallback.
 * 
 * @param {string} agentId - UUID of the voice agent to filter documents
 * @returns {Promise<Array<{title: string, content: string}>|null>}
 */
async function fetchSupabaseDocuments(agentId) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    return null;
  }

  try {
    let url = `${process.env.SUPABASE_URL}/rest/v1/voice_agents_knowledge?select=title,content`;
    if (agentId) {
      url += `&or=(agent_id.eq.${agentId},agent_id.is.null)`;
    } else {
      url += `&agent_id.is.null`;
    }

    console.log(`[avr_search_knowledge_base] Fetching knowledge from Supabase for agentId: ${agentId || "global"}`);
    const res = await axios.get(url, {
      headers: {
        apikey: process.env.SUPABASE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_KEY}`
      },
      timeout: 3000 // 3-second timeout limit to avoid blocking
    });

    if (res.data && Array.isArray(res.data)) {
      return res.data;
    }
    return null;
  } catch (err) {
    console.error(`[avr_search_knowledge_base] Supabase query failed: ${err.message}. Falling back to local files.`);
    return null;
  }
}

module.exports = {
  name: "avr_search_knowledge_base",
  description: "Searches the support knowledge base (policies, manuals, Q&A) for relevant information to answer specific questions from the customer. Use this tool when the customer asks about policies, rules, procedures, work hours, or any internal guidelines.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query or question from the customer to look up in the knowledge base."
      }
    },
    required: ["query"]
  },
  handler: async (uuid, { query }, context) => {
    const agentId = context?.agentId || "";
    console.log(`[avr_search_knowledge_base] Executing search for UUID: ${uuid}, agentId: ${agentId}, query: "${query}"`);

    // 1. Check cache for this specific agentId
    const now = Date.now();
    const cached = dbCache.get(agentId);
    if (cached && (now - cached.timestamp < CACHE_TTL_MS)) {
      console.log(`[avr_search_knowledge_base] Serving query from cache for agentId: ${agentId}`);
      return searchDocuments(cached.documents, query);
    }

    // 2. Fetch from Supabase (if configured)
    let documents = await fetchSupabaseDocuments(agentId);

    if (documents) {
      // Update cache
      dbCache.set(agentId, { documents, timestamp: now });
      console.log(`[avr_search_knowledge_base] Updated cache for agentId: ${agentId} with ${documents.length} docs`);
    } else {
      // 3. Fallback to local files if Supabase is not available or query fails
      console.log(`[avr_search_knowledge_base] Falling back to local knowledge base files.`);
      documents = loadLocalDocuments();
      // Store in memory mapping as fallback to prevent repeated fs reads for this agent
      dbCache.set(agentId, { documents, timestamp: now });
    }

    return searchDocuments(documents, query);
  }
};
