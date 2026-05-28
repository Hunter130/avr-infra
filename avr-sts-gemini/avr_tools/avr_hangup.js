require("dotenv").config();

const axios = require("axios");

module.exports = {
  name: "avr_hangup",
  description:
    "Ends the conversation once the maintenance is booked or if no availability is found.",
  input_schema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "The reason for hanging up the call. Examples: 'assistant-ended-call', 'voicemail', 'customer-busy'."
      }
    },
    required: [],
  },
  handler: async (uuid, { reason }) => {
    console.log("Hangup call");
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
