const { GoogleGenAI } = require("@google/genai");
const ai = new GoogleGenAI({ apiKey: "test_key" });

ai.live.webSocketFactory = {
  create: (url, headers, callbacks) => {
    return {
      connect: () => {
        setTimeout(() => callbacks.onopen(), 10);
      },
      send: (msg) => {
        console.log("SENT MESSAGE:\n", JSON.stringify(JSON.parse(msg), null, 2));
      },
      close: () => {}
    };
  }
};

ai.live.connect({
  model: "gemini-2.5-flash-native-audio-preview-12-2025",
  config: {
    realtimeInputConfig: {
      automaticActivityDetection: {
        disabled: false,
        startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
        endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
        silenceDurationMs: 300,
        prefixPaddingMs: 100
      }
    }
  }
}).then(session => {
  process.exit(0);
});
