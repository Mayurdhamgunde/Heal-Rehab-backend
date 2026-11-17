const axios = require("axios");
require("dotenv").config();
const API_KEY = process.env.API_KEY;
const chat = async (req, res) => {
  const userInput = req.body.user_input;

  if (!userInput) {
    return res.status(400).json({ error: "No user input provided" });
  }

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY}`,
      {
        contents: [{ parts: [{ text: userInput }] }],
      }
    );

    const botResponse =
      response.data.candidates[0]?.content?.parts[0]?.text || "No response";
    res.json({ response: botResponse });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Error fetching response from Gemini API" });
  }
};

module.exports = { chat };
