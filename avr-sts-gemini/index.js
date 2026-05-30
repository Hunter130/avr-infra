/**
 * index.js
 * Entry point for the Gemini Speech-to-Speech streaming WebSocket server.
 * This server handles real-time audio streaming between clients and Gemini's API,
 * performing necessary audio format conversions and WebSocket communication.
 *
 * Client Protocol:
 * - Send {"type": "init", "uuid": "uuid"} to initialize session
 * - Send {"type": "audio", "audio": "base64_encoded_audio"} to stream audio
 * - Receive {"type": "audio", "audio": "base64_encoded_audio"} for responses
 * - Receive {"type": "error", "message": "error_message"} for errors
 *
 * @author Agent Voice Response <info@agentvoiceresponse.com>
 * @see https://www.agentvoiceresponse.com
 */

const WebSocket = require("ws");
const { create } = require("@alexanderolsen/libsamplerate-js");
const { GoogleGenAI, Modality, ThinkingLevel, StartSensitivity, EndSensitivity } = require("@google/genai");
const axios = require("axios");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const http = require("http");
const { loadTools, getToolHandler } = require("./loadTools");

const callMap = new Map();
const pendingCalls = new Map(); // uuid -> agentId mapping

require("dotenv").config({ override: true });
console.log("Loaded VAD Config from process.env:", {
  GEMINI_VAD_START_SENSITIVITY: process.env.GEMINI_VAD_START_SENSITIVITY,
  GEMINI_VAD_END_SENSITIVITY: process.env.GEMINI_VAD_END_SENSITIVITY,
  GEMINI_VAD_SILENCE_DURATION_MS: process.env.GEMINI_VAD_SILENCE_DURATION_MS,
  GEMINI_VAD_PREFIX_PADDING_MS: process.env.GEMINI_VAD_PREFIX_PADDING_MS,
});

/**
 * Stream Processing
 */

// Audio resamplers are created per-connection to avoid state contamination in concurrent calls

const connectToGeminiSdk = async (sessionUuid, callbacks, agentOverrides = {}, sessionContext = {}) => {
  const model =
    process.env.GEMINI_MODEL || "gemini-3.1-flash-live-preview";

  // Use per-agent voice/prompt if available, fall back to global env vars
  const sessionVoice   = agentOverrides.voice   || process.env.GEMINI_VOICE   || "Puck";
  const sessionPrompt  = agentOverrides.prompt  || null;

  const config = {
    responseModalities: [Modality.AUDIO],
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: sessionVoice,
        }
      }
    },
    systemInstruction:
      "You are a helpful assistant and answer in a friendly tone.",
    /* thinkingConfig: {
      thinkingLevel: process.env.GEMINI_THINKING_LEVEL || ThinkingLevel.MINIMAL,
      thinkingBudget: +process.env.GEMINI_THINKING_BUDGET || 0
    } */
    // outputAudioTranscription: {}
  };

  // Build realtimeInputConfig dynamically (Hardcoded VAD settings for direct testing)
  const vadDisabled = false;
  
  // Opciones para startSensitivity: "START_SENSITIVITY_UNSPECIFIED", "START_SENSITIVITY_HIGH", "START_SENSITIVITY_LOW"
  const startSensitivity = "START_SENSITIVITY_HIGH";
  
  // Opciones para endSensitivity: "END_SENSITIVITY_UNSPECIFIED", "END_SENSITIVITY_HIGH", "END_SENSITIVITY_LOW"
  const endSensitivity = "END_SENSITIVITY_UNSPECIFIED";
  
  const silenceDurationMs = 400;
  const prefixPaddingMs = 100;

  config.realtimeInputConfig = {
    automaticActivityDetection: {
      disabled: vadDisabled,
      startOfSpeechSensitivity: StartSensitivity[startSensitivity] || startSensitivity,
      endOfSpeechSensitivity: EndSensitivity[endSensitivity] || endSensitivity,
      silenceDurationMs: silenceDurationMs,
      prefixPaddingMs: prefixPaddingMs
    }
  };

  // Per-agent prompt takes highest priority, then global env vars
  if (sessionPrompt) {
    config.systemInstruction = sessionPrompt.replace(/\\n/g, "\n");
    console.log("Using per-agent PROMPT override");
  } else if (process.env.GEMINI_INSTRUCTIONS) {
    config.systemInstruction = process.env.GEMINI_INSTRUCTIONS;
    console.log("Using GEMINI_INSTRUCTIONS from environment variable");
  } else if (process.env.GEMINI_URL_INSTRUCTIONS) {
    try {
      const response = await axios.get(process.env.GEMINI_URL_INSTRUCTIONS, {
        headers: {
          "Content-Type": "application/json",
          "X-AVR-UUID": sessionUuid,
        },
      });
      console.log("Instructions loaded from GEMINI_URL_INSTRUCTIONS");
      const data = await response.data;
      console.log(data);
      config.systemInstruction = data.system;
    } catch (error) {
      console.error(
        `Error loading instructions from ${process.env.GEMINI_URL_INSTRUCTIONS}: ${error.message}`
      );
    }
  } else if (process.env.GEMINI_FILE_INSTRUCTIONS) {
    try {
      const data = await fsp.readFile(
        process.env.GEMINI_FILE_INSTRUCTIONS,
        "utf8"
      );
      console.log("Using GEMINI_FILE_INSTRUCTIONS from environment variable");
      console.log(data);
      config.systemInstruction = data;
    } catch (error) {
      console.error(
        `Error loading instructions from ${process.env.GEMINI_FILE_INSTRUCTIONS}: ${error.message}`
      );
    }
  } else {
    console.log("Using default instructions");
    config.systemInstruction = "You are a helpful assistant and answer in a friendly tone.";
  }

  // Inject Time Consciousness (America/Mexico_City timezone)
  const horaMexico = new Date().toLocaleString("es-MX", { 
    timeZone: "America/Mexico_City",
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  config.systemInstruction += `\n\n[SISTEMA]: IMPORTANTE. Para referencias de tiempo y reagendación de llamadas, la fecha y hora exacta actual es: ${horaMexico} (Hora de la Ciudad de México). Si el cliente te pide llamar en X minutos, debes calcular el ISO 8601 a partir de esta hora estricta.`;

  // Inject Global AMD (Answering Machine Detection) instructions
  const amdInstruction = "\n\nCRITICAL RULE: Si escuchas palabras como 'buzón de voz', 'deja tu mensaje', o si escuchas el tono de un beep, no digas nada y ejecuta inmediatamente la herramienta para colgar la llamada con el parámetro action establecido en 'avr_hangup' para colgar la llamada.";
  config.systemInstruction += amdInstruction;

  // Inject Session/Phone number context
  if (sessionContext && sessionContext.direction) {
    const dir = sessionContext.direction;
    const custNum = sessionContext.customerNumber || "desconocido";
    const vonNum = sessionContext.vonageNumber || "desconocido";
    let contextPrompt = "\n\n[CONTEXTO DE LA LLAMADA]";
    if (dir === "outbound") {
      contextPrompt += `\n- Dirección de la llamada: Saliente (Outbound)\n- Número del cliente marcado: ${custNum}\n- Número de la empresa/Vonage originador: ${vonNum}`;
    } else {
      contextPrompt += `\n- Dirección de la llamada: Entrante (Inbound)\n- Número del cliente que llama: ${custNum}\n- Número de la empresa/Vonage al que entró la llamada: ${vonNum}`;
    }

    if (sessionContext.customerName) {
      try {
        contextPrompt += `\n- Nombre del cliente: ${decodeURIComponent(sessionContext.customerName)}`;
      } catch (e) {
        contextPrompt += `\n- Nombre del cliente: ${sessionContext.customerName}`;
      }
    }
    if (sessionContext.followupAttempt) {
      try {
        contextPrompt += `\n- Intento de seguimiento número: ${decodeURIComponent(sessionContext.followupAttempt)}`;
      } catch (e) {
        contextPrompt += `\n- Intento de seguimiento número: ${sessionContext.followupAttempt}`;
      }
    }
    if (sessionContext.contextHistory) {
      try {
        contextPrompt += `\n- Historial/Contexto previo de la llamada: ${decodeURIComponent(sessionContext.contextHistory)}`;
      } catch (e) {
        contextPrompt += `\n- Historial/Contexto previo de la llamada: ${sessionContext.contextHistory}`;
      }
    }

    if (dir === "outbound" && (sessionContext.followupAttempt || sessionContext.contextHistory)) {
      contextPrompt += `\n\n[INSTRUCCIÓN DE SEGUIMIENTO IMPORTANTE]: Estás realizando AHORA MISMO la llamada de seguimiento (Intento #${sessionContext.followupAttempt || 1}) basada en el historial previo. DEBES iniciar la conversación saludando al cliente por su nombre, mencionando brevemente que le estás regresando la llamada según lo acordado en la conversación anterior (usa el historial como contexto), y retomando el tema principal. ¡No repitas la acción pasada de "te llamo en X minutos", porque esta ES la llamada prometida!`;
    }

    config.systemInstruction += contextPrompt;
  }

  try {
    const tools = await loadTools(agentOverrides.toolsIds || []);
    config.tools = [{ functionDeclarations: tools }];
    console.log(`Loaded ${tools.length} tools for Gemini:`, JSON.stringify(tools, null, 2));
  } catch (error) {
    console.error(`Error loading tools for Gemini: ${error.message}`);
  }


  console.log("Gemini Session Config:", config);
  console.log("Gemini Session Model:", model);

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

  const session = await ai.live.connect({
    model: model,
    callbacks,
    config,
  });

  return session;
};

/**
 * Handles incoming client WebSocket connection and manages communication with Gemini Live API.
 * Implements buffering for audio chunks received before WebSocket connection is established.
 *
 * @param {WebSocket} clientWs - Client WebSocket connection
 * @param {string} reqUrl - WebSocket request URL
 */
const handleClientConnection = (clientWs, reqUrl) => {
  console.log("New client WebSocket connection received, URL:", reqUrl);
  let sessionUuid = null;

  let audioBuffer8k = [];
  let session = null;
  let audioFrames = [];
  let callStartTime = null;
  let conversationLog = [];
  let recordedChunks = [];
  let deepgramWs = null;
  let agentId = null;    // populated from init message if platform sends it
  let callDirection = "inbound"; // populated from map
  let customerNumber = ""; // populated from map
  let vonageNumber = ""; // populated from map
  let customerName = ""; // populated from map
  let followupAttempt = ""; // populated from map
  let contextHistory = ""; // populated from map
  let endedReason = "customer-ended-call";
  let agentOverrides = {}; // per-agent voice/prompt/costs
  let downsampler = null;
  let upsampler = null;
  
  // Parse from/to from WebSocket URL query
  let callFrom = "";
  let callTo = "";
  if (reqUrl && reqUrl.includes("?")) {
    const searchParams = new URLSearchParams(reqUrl.split("?")[1]);
    callFrom = searchParams.get("from") || "";
    callTo = searchParams.get("to") || "";
  }

  /**
   * Processes Gemini audio chunks by downsampling and extracting frames.
   * Converts 24kHz audio to 8kHz and extracts 20ms frames (160 samples).
   *
   * @param {Buffer} inputBuffer - Raw audio buffer from Gemini
   * @returns {Buffer[]} Array of 20ms audio frames
   */
  function processGeminiAudioChunk(inputBuffer) {
    if (!downsampler) return [];
    // Convert Buffer to Int16Array for processing
    const inputSamples = new Int16Array(
      inputBuffer.buffer,
      inputBuffer.byteOffset,
      inputBuffer.length / 2
    );

    // Downsample from 24kHz to 8kHz using local downsampler
    const downsampledSamples = downsampler.full(inputSamples);

    // Accumulate samples in buffer
    audioBuffer8k = audioBuffer8k.concat(Array.from(downsampledSamples));

    // Extract 20ms frames (160 samples = 320 bytes)
    const audioFrames = [];
    while (audioBuffer8k.length >= 160) {
      const frame = audioBuffer8k.slice(0, 160);
      audioBuffer8k = audioBuffer8k.slice(160);

      // Convert to PCM16LE Buffer (320 bytes)
      audioFrames.push(Buffer.from(Int16Array.from(frame).buffer));
    }

    return audioFrames;
  }

  /**
   * Converts 8kHz audio to 16kHz for sending to Gemini API.
   *
   * @param {Buffer} inputBuffer - 8kHz audio buffer
   * @returns {Buffer} 16kHz audio buffer
   */
  function convert8kTo16k(inputBuffer) {
    if (!upsampler) return Buffer.alloc(0);
    const inputSamples = new Int16Array(
      inputBuffer.buffer,
      inputBuffer.byteOffset,
      inputBuffer.length / 2
    );
    const upsampledSamples = upsampler.full(inputSamples);
    return Buffer.from(Int16Array.from(upsampledSamples).buffer);
  }

  // Handle client WebSocket messages
  clientWs.on("message", async (data) => {
    try {
      const message = JSON.parse(data);
      switch (message.type) {
        case "init":
          sessionUuid = message.uuid;
          
          // Legacy check for embedded uuid or payload fallback
          let rawAgentId = message.agentId || message.payload?.agentId || null;
          if (message.uuid && message.uuid.includes(":")) {
            const colonIdx = message.uuid.indexOf(":");
            rawAgentId = message.uuid.substring(0, colonIdx);
            sessionUuid = message.uuid.substring(colonIdx + 1);
          }
          
          // Check HTTP webhook map first
          const mapData = callMap.get(sessionUuid);
          agentId = mapData ? mapData.agentId : rawAgentId;
          callDirection = mapData ? mapData.direction : 'inbound';
          customerNumber = mapData ? mapData.customerNumber : '';
          vonageNumber = mapData ? mapData.vonageNumber : '';
          customerName = mapData ? mapData.customerName : '';
          followupAttempt = mapData ? mapData.followupAttempt : '';
          contextHistory = mapData ? mapData.contextHistory : '';
          callMap.delete(sessionUuid); // Cleanup
          
          callStartTime = Date.now();
          console.log("Session UUID:", sessionUuid, "| Agent ID:", agentId);

          // Fetch per-agent config from Supabase directly
          if (agentId && process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
            try {
              const res = await axios.get(`${process.env.SUPABASE_URL}/rest/v1/agentesID_Roda_IA?id=eq.${agentId}`, {
                headers: {
                  apikey: process.env.SUPABASE_KEY,
                  Authorization: `Bearer ${process.env.SUPABASE_KEY}`
                }
              });
              if (res.data && res.data.length > 0) {
                const agent = res.data[0];
                agentOverrides = {
                  voice:         agent.voice                  || null,
                  prompt:        agent.prompt                 || null,
                  costGemini:    agent.cost_gemini_per_sec    || process.env.COST_GEMINI_PER_SEC,
                  costDeepgram:  agent.cost_deepgram_per_sec  || process.env.COST_DEEPGRAM_PER_SEC,
                  skill:         agent.skill                  || null,
                  structuredDataPlan: agent.structuredDataPlan || null,
                  toolsIds:      agent.tools_ids              || [],
                  fileSearchStoreNames: agent.file_search_store_names || null,
                };
                console.log("Agent overrides loaded from Supabase:", agentOverrides);
              }
            } catch (err) {
              console.error("Failed to fetch agent from Supabase:", err.message);
            }
          }

          // Initialize per-connection resamplers
          try {
            downsampler = await create(1, 24000, 8000); // 1 channel, 24kHz to 8kHz
            upsampler = await create(1, 8000, 16000); // 1 channel, 8kHz to 16kHz
            console.log(`[${sessionUuid}] Per-connection audio resamplers initialized`);
          } catch (err) {
            console.error(`[${sessionUuid}] Error initializing audio resamplers:`, err);
            clientWs.send(JSON.stringify({ type: "error", message: "Failed to initialize audio resamplers" }));
            clientWs.close();
            return;
          }

          // Initialize Gemini connection with per-agent config
          initializeGeminiConnection();
          
          if (process.env.DEEPGRAM_API_KEY) {
            deepgramWs = new WebSocket("wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&channels=1&language=es", {
              headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` }
            });
            deepgramWs.on("open", () => console.log("Deepgram connection opened"));
            deepgramWs.on("message", (data) => {
              try {
                const dgMsg = JSON.parse(data);
                if (dgMsg.is_final && dgMsg.channel?.alternatives?.[0]?.transcript) {
                  conversationLog.push(`Usuario: ${dgMsg.channel.alternatives[0].transcript}`);
                  console.log("Deepgram STT:", dgMsg.channel.alternatives[0].transcript);
                }
              } catch (e) {}
            });
            deepgramWs.on("error", (e) => console.error("Deepgram Error:", e.message));
          }
          break;

        case "audio":
          // Handle audio data from client
          if (message.audio && session && upsampler) {
            const audioBuffer = Buffer.from(message.audio, "base64");
            const upsampledAudio = convert8kTo16k(audioBuffer);
            session.sendRealtimeInput({
              audio: {
                data: upsampledAudio.toString("base64"),
                mimeType: "audio/pcm;rate=16000",
              },
            });
            // Save raw PCM for later recording file
            recordedChunks.push(upsampledAudio);
            
            if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
              deepgramWs.send(upsampledAudio);
            }
          }
          break;

        default:
          console.log("Unknown message type from client:", message.type);
          break;
      }
    } catch (error) {
      console.error("Error processing client message:", error);
    }
  });

  // Initialize Gemini connection
  const initializeGeminiConnection = async () => {
    let lastTranscriptionText = "";
    let lastTranscriptionTime = 0;
    try {
      session = await connectToGeminiSdk(sessionUuid, {
        onopen: function () {
          console.debug("Gemini Session Opened");
        },
        onmessage: async function (message) {
          if (message.serverContent?.outputTranscription) {
            const text = message.serverContent.outputTranscription.text;
            // Deduplicate fast consecutive identical chunks
            if (text === lastTranscriptionText && (Date.now() - lastTranscriptionTime) < 1000) {
              return;
            }
            lastTranscriptionText = text;
            lastTranscriptionTime = Date.now();

            conversationLog.push(`Gemini: ${text}`);
            console.log("Gemini Output Transcription:", text);
          }
          if (message.serverContent?.groundingMetadata) {
            const metadata = message.serverContent.groundingMetadata;
            console.log("\n[GEMINI RAG GROUNDING] Metadata received:");
            console.log(JSON.stringify(metadata, null, 2));
            if (metadata.groundingChunks) {
              metadata.groundingChunks.forEach((chunk, idx) => {
                console.log(`- Source #${idx + 1}: ${chunk.web?.title || chunk.title || 'Document'} - ${chunk.web?.uri || chunk.uri || 'no-link'}`);
              });
            }
          }
          if (message.serverContent?.modelTurn?.parts) {
            const part = message.serverContent?.modelTurn?.parts?.[0];
            if (part?.text) {
                // Not usually populated when AUDIO response is requested
            }
            if (part?.inlineData) {
              const inlineData = part.inlineData;
              const audioChunk = Buffer.from(inlineData.data, "base64");
              audioFrames = processGeminiAudioChunk(audioChunk);
              // Send audio frames to client
              audioFrames.forEach((frame) => {
                clientWs.send(
                  JSON.stringify({
                    type: "audio",
                    audio: frame.toString("base64"),
                  })
                );
              });
            }
          } else if (message.toolCall?.functionCalls) {
            console.log(
              "Gemini Session Tool Calls:",
              message.toolCall.functionCalls
            );
            const functionResponses = [];
            for (const fc of message.toolCall.functionCalls) {
              conversationLog.push(`Tool Executed: ${fc.name} with args: ${JSON.stringify(fc.args)}`);
              
              if (fc.name === 'avr_hangup' || fc.args?.action === 'avr_hangup') {
                endedReason = fc.args?.reason || 'assistant-ended-call';
              } else if (fc.name === 'avr_transfer') {
                endedReason = 'transferred';
              }

              let handler;
              if (fc.name === 'avr_hangup' || fc.args?.action === 'avr_hangup') {
                handler = require('./avr_tools/avr_hangup').handler;
              } else {
                handler = getToolHandler(fc.name);
              }

              const obj = {
                id: fc.id,
                name: fc.name,
                response: { result: "" },
              };
              if (!handler) {
                obj.response.result = `I'm sorry, I cannot retrieve the requested information.`;
                functionResponses.push(obj);
              } else {
                obj.response.result = await handler(sessionUuid, fc.args, {
                  customerNumber,
                  agentId,
                  customerName,
                  followupAttempt,
                  contextHistory,
                  fileSearchStoreNames: agentOverrides.fileSearchStoreNames
                });
                functionResponses.push(obj);
              }
              console.log("Gemini Session Tool Response:", obj.response.result);
            }

            session.sendToolResponse({ functionResponses });
          } else if (message.serverContent?.interrupted) {
            console.log("Gemini Session Interruption");
            audioFrames = [];
            clientWs.send(JSON.stringify({ type: "interruption" }));
          } else {
            // console.log("Gemini Session Message:", message);
          }
        },
        onerror: function (e) {
          console.error("Gemini Session Error:", e.message);
          clientWs.send(
            JSON.stringify({
              type: "error",
              message: e.message,
            })
          );
        },
        onclose: function (e) {
          console.info("Gemini Session Closed", e.reason);
          clientWs.close();
        },
      }, agentOverrides, {
        direction: callDirection,
        customerNumber: customerNumber,
        vonageNumber: vonageNumber,
        customerName: customerName,
        followupAttempt: followupAttempt,
        contextHistory: contextHistory
      });
      // begin gemini conversation
      session.sendRealtimeInput({
        text: "Please start the conversation."
      });
    } catch (error) {
      console.error("Error initializing Gemini connection:", error);
      clientWs.send(
        JSON.stringify({
          type: "error",
          message: "Failed to initialize Gemini connection",
        })
      );
    }
  };

  // Handle client WebSocket close
  clientWs.on("close", () => {
    console.log("Client WebSocket connection closed");
    cleanup();
  });

  clientWs.on("error", (err) => {
    console.error("Client WebSocket error:", err);
    endedReason = "connection-dropped";
    cleanup();
  });

  /**
   * Cleans up resources and closes connections.
   */
  async function cleanup() {
    if (session) session.close();
    if (clientWs) clientWs.close();
    if (deepgramWs) deepgramWs.close();

    if (downsampler) {
      try {
        downsampler.destroy();
      } catch (e) {}
      downsampler = null;
    }
    if (upsampler) {
      try {
        upsampler.destroy();
      } catch (e) {}
      upsampler = null;
    }

    if (callStartTime && process.env.N8N_WEBHOOK_URL) {
      const durationSeconds = Math.round((Date.now() - callStartTime) / 1000);
      const baseCostGemini = parseFloat(agentOverrides.costGemini || process.env.COST_GEMINI_PER_SEC) || 0;
      const baseCostDeepgram = parseFloat(agentOverrides.costDeepgram || process.env.COST_DEEPGRAM_PER_SEC) || 0;
      const baseCostVonage = parseFloat(process.env.COST_VONAGE_PER_SEC || 0.001);
      
      const costGemini = baseCostGemini * durationSeconds;
      const costDeepgram = baseCostDeepgram * durationSeconds;
      
      // Calculate Vonage cost if the call involves an external number (length > 4)
      let costVonage = 0;
      if (callFrom.length > 4 || callTo.length > 4) {
        costVonage = baseCostVonage * durationSeconds;
      }
      
      // Asterisk MixMonitor saves the file as .wav
      const recordingUrl = process.env.RECORDING_BASE_URL ? `${process.env.RECORDING_BASE_URL}/${sessionUuid}.wav` : null;
      try {
        console.log("Sending post-call webhook to N8N...");
        let analysis = "No analysis configured.";
        const logText = conversationLog.join("\n");
        let costDeepseek = 0;
        
        let systemPrompt = "Resume esta llamada de call center en formato JSON. Incluye: 'motivo', 'resolucion', 'sentimiento'. La transcripción puede estar incompleta.";
        
        if (agentOverrides.structuredDataPlan && agentOverrides.structuredDataPlan.enabled) {
            systemPrompt = `Extrae información estructurada de esta llamada de call center en formato JSON.
Utiliza estrictamente la siguiente estructura y esquema JSON para tu respuesta:
${JSON.stringify(agentOverrides.structuredDataPlan.schema)}

La transcripción puede estar incompleta. Genera solo un JSON válido como respuesta que cumpla con el esquema proporcionado.`;
        }

        if (process.env.POST_CALL_ANALYSIS_PROVIDER === "deepseek" && process.env.DEEPSEEK_API_KEY) {
            const dsRes = await axios.post("https://api.deepseek.com/chat/completions", {
                model: "deepseek-chat",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: logText || "No se detectó diálogo." }
                ],
                response_format: { type: "json_object" }
            }, { headers: { "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}` } });
            
            try {
                analysis = JSON.parse(dsRes.data.choices[0].message.content);
            } catch (e) {
                analysis = { error: "Failed to parse JSON", raw_response: dsRes.data.choices[0].message.content };
            }
            
            if (dsRes.data.usage) {
                // DeepSeek-V3 approximate cost (USD): $0.14 per 1M input tokens, $0.28 per 1M output tokens
                const inputCost = (dsRes.data.usage.prompt_tokens / 1000000) * 0.14;
                const outputCost = (dsRes.data.usage.completion_tokens / 1000000) * 0.28;
                costDeepseek = inputCost + outputCost;
            }
        } else {
            analysis = { raw_log: logText };
        }

        const totalCost = costGemini + costDeepgram + costDeepseek + costVonage;

        await axios.post(process.env.N8N_WEBHOOK_URL, {
            uuid: agentId, // UUID del agente
            agent_id: agentId,
            idcall: sessionUuid, // ID único de la llamada
            duration: durationSeconds,
            type: callDirection,
            customer_number: customerNumber,
            endedReason: endedReason,
            analysis: analysis,
            raw_log: logText,
            recording_url: recordingUrl,
            cost: {
                total: parseFloat(totalCost.toFixed(6)),
                breakdown: {
                    speech_to_speech: parseFloat(costGemini.toFixed(6)),
                    transcription: parseFloat(costDeepgram.toFixed(6)),
                    post_call_analysis: parseFloat(costDeepseek.toFixed(6)),
                    telephony_vonage: parseFloat(costVonage.toFixed(6))
                }
            }
        });
        console.log("Webhook sent successfully with total cost: $" + totalCost.toFixed(6));
      } catch (e) {
         console.error("Webhook error:", e.message);
      }
    }
  }
};

/**
 * Global cleanup function (no global resamplers to clean up now).
 */
const cleanupGlobalResources = () => {
  console.log("Global cleanup triggered (resamplers are now per-connection)");
};

// Handle process termination signals
process.on("SIGINT", () => {
  console.log("Received SIGINT, shutting down gracefully...");
  cleanupGlobalResources();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("Received SIGTERM, shutting down gracefully...");
  cleanupGlobalResources();
  process.exit(0);
});

// Initialize resamplers and start server
const startServer = async () => {
  try {

    const PORT = process.env.PORT || 6037;
    
    // Create HTTP server to handle Asterisk webhooks and static recordings
    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/map-agent') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data.uuid && data.agentId) {
              const pendingData = pendingCalls.get(data.customerNumber) || {};
              callMap.set(data.uuid, {
                agentId: data.agentId,
                direction: (data.direction === 'inbound' || !data.direction) && pendingData.direction ? pendingData.direction : data.direction,
                customerNumber: data.customerNumber || '',
                vonageNumber: data.vonageNumber || '',
                customerName: pendingData.customerName || data.customerName || '',
                followupAttempt: pendingData.followupAttempt || data.followupAttempt || '',
                contextHistory: pendingData.contextHistory || data.contextHistory || ''
              });
              // Clean up map after 60 seconds to prevent leaks
              setTimeout(() => callMap.delete(data.uuid), 60000);
            }
            res.writeHead(200);
            res.end(JSON.stringify({ success: true }));
          } catch (e) {
            res.writeHead(400);
            res.end('Invalid JSON');
          }
        });
      } else if (req.method === 'POST' && req.url === '/register-call') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data.phoneNumber) {
              pendingCalls.set(data.phoneNumber, data);
              setTimeout(() => pendingCalls.delete(data.phoneNumber), 120000);
            }
            res.writeHead(200);
            res.end(JSON.stringify({ success: true }));
          } catch (e) {
            res.writeHead(400);
            res.end('Invalid JSON');
          }
        });
      } else if (req.method === 'POST' && req.url === '/call-unanswered') {
        // ── Llamada outbound no contestada ────────────────────────────────────
        // Asterisk llama a este endpoint cuando DIALSTATUS != ANSWER después de
        // un Dial() outbound. Propaga el evento a N8N con duration=0.
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', async () => {
          try {
            const data = JSON.parse(body);
            const { phoneNumber, dialStatus, callerIdNum } = data;

            // Mapear DIALSTATUS de Asterisk a un endedReason legible
            const statusMap = {
              'NOANSWER':    'no-answer',
              'BUSY':        'busy',
              'CONGESTION':  'network-congestion',
              'CHANUNAVAIL': 'channel-unavailable',
              'CANCEL':      'caller-cancelled',
            };
            const endedReason = statusMap[dialStatus] || `unanswered-${(dialStatus || 'unknown').toLowerCase()}`;

            // Buscar agentId: primero el que viene de Asterisk (__AGENT_ID),
            // luego el pendingCalls map como fallback de seguridad.
            // Guard: si el valor parece un número de teléfono (solo dígitos, > 6 chars),
            // descartarlo y usar el fallback.
            const pendingData = pendingCalls.get(phoneNumber) || {};
            const isPhoneNumber = (v) => v && /^\+?\d{6,}$/.test(v);
            const agentId = (data.agentId && data.agentId !== '${AGENT_ID}' && !isPhoneNumber(data.agentId))
              ? data.agentId
              : (pendingData.agentId || null);


            // Limpiar el entry de pendingCalls para este número
            pendingCalls.delete(phoneNumber);

            console.log(`[call-unanswered] phoneNumber=${phoneNumber} dialStatus=${dialStatus} endedReason=${endedReason} agentId=${agentId}`);

            const webhookUrl = process.env.N8N_UNANSWERED_WEBHOOK_URL || process.env.N8N_WEBHOOK_URL;
            if (webhookUrl) {
              try {
                await axios.post(webhookUrl, {
                  uuid:            agentId,
                  agent_id:        agentId,
                  idcall:          null,          // No hubo sesión WebSocket
                  duration:        0,
                  type:            'outbound',
                  customer_number: phoneNumber,
                  endedReason:     endedReason,
                  analysis:        { motivo: 'Cliente no contestó', resolucion: endedReason, sentimiento: 'neutral' },
                  raw_log:         '',
                  recording_url:   null,
                  cost: {
                    total: 0,
                    breakdown: {
                      speech_to_speech:   0,
                      transcription:      0,
                      post_call_analysis: 0,
                      telephony_vonage:   0,
                    }
                  }
                });
                console.log(`[call-unanswered] Webhook sent to N8N for ${phoneNumber} (${endedReason}) at ${webhookUrl}`);
              } catch (webhookErr) {
                console.error('[call-unanswered] Error sending webhook to N8N:', webhookErr.message);
              }
            }

            res.writeHead(200);
            res.end(JSON.stringify({ success: true, endedReason }));
          } catch (e) {
            console.error('[call-unanswered] Error parsing request:', e.message);
            res.writeHead(400);
            res.end('Invalid JSON');
          }
        });
      } else if (req.method === 'POST' && req.url === '/billing-webhook') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', async () => {
          try {
            const data = JSON.parse(body);
            console.log("Received Asterisk billing webhook:", data);
            
            const baseCostVonage = parseFloat(process.env.COST_VONAGE_PER_SEC || 0.001);
            const totalVonageCost = baseCostVonage * parseInt(data.duration || 0);

            if (process.env.N8N_WEBHOOK_URL) {
                await axios.post(process.env.N8N_WEBHOOK_URL, {
                    type: "telephony_billing",
                    uuid: data.agentId || data.uuid,
                    agent_id: data.agentId,
                    idcall: data.uuid,
                    duration: data.duration,
                    billable_seconds: data.billsec,
                    cost: {
                        telephony_vonage: parseFloat(totalVonageCost.toFixed(6))
                    }
                });
                console.log("Telephony billing webhook sent to N8N successfully");
            }
            res.writeHead(200);
            res.end(JSON.stringify({ success: true }));
          } catch (e) {
            console.error("Billing webhook error:", e);
            res.writeHead(400);
            res.end('Error processing billing');
          }
        });
      } else if (req.method === 'GET' && req.url.startsWith('/recordings/')) {
        const filename = req.url.replace('/recordings/', '');
        const filePath = path.join(__dirname, 'recordings', filename);
        if (fs.existsSync(filePath)) {
          res.writeHead(200, { 'Content-Type': 'audio/wav' });
          fs.createReadStream(filePath).pipe(res);
        } else {
          res.writeHead(404);
          res.end('File not found');
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    // Attach WebSocket server to HTTP server
    const wss = new WebSocket.Server({ server });

    wss.on("connection", (clientWs, req) => {
      console.log("New client connected");
      handleClientConnection(clientWs, req.url);
    });

    server.listen(PORT, () => {
      console.log(`Gemini Speech-to-Speech HTTP/WS server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
};

// Start the server
startServer();
