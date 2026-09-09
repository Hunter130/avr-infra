require("dotenv").config();

const axios = require("axios");

module.exports = {
  name: "avr_hangup",
  description:
    "Ends the phone call when the conversation is finished, voicemail/answering machine is detected, silence timeout occurs, or customer is busy.",
  input_schema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "The reason for hanging up the call. Examples: 'assistant-ended-call', 'voicemail', 'silence-timeout', 'customer-busy'."
      },
      action: {
        type: "string",
        description: "Action name, should be 'avr_hangup'."
      }
    },
    required: [],
  },
  handler: async (uuid, { reason, action } = {}) => {
    console.log(`Hangup call: reason=${reason || 'unspecified'}, action=${action || 'avr_hangup'}`);
    const url = process.env.AMI_URL || "http://127.0.0.1:6006";
    try {
      const res = await axios.post(`${url}/hangup`, { uuid });
      console.log("Hangup response:", res.data);
      return res.data.message;
    } catch (error) {
      console.error("Error during hangup:", error.message);
      return `Error during hangup: ${error.message}`;
    }
  },
};
