# gemini.py (FINAL CLEAN CODE)
import os
from google.genai import Client, types
from typing import List
import logging

# Set up logging for better backend debugging
logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

# --- Configuration ---
GEMINI_API_KEY = ""

client = None
try:
    if GEMINI_API_KEY:
        client = Client(api_key=GEMINI_API_KEY)
        logger.info("Gemini client initialized successfully.")
    else:
        logger.error("GEMINI_API_KEY environment variable is not set.")
except Exception as e:
    logger.error(f"Gemini client initialization failed: {e}")
    client = None

# System instruction to define the assistant's role
SYSTEM_INSTRUCTION = (
    "You are a friendly, helpful AI assistant focused on urban safety and navigation. "
    "Your persona is to be concise, polite, and to prioritize information related to "
    "safe routes, local risks, and urban planning. Do not invent travel times or risk "
    "scores; state that the information is map-dependent if the data isn't available. "
    "Keep your responses short and relevant to the user's inquiry."
)


def get_gemini_response(db_messages: List) -> str:
    """
    Generates a response from the Gemini model based on the chat history.
    """
    if not client:
        raise Exception("AI service is unavailable: Gemini client not configured or API key missing.")

    if len(db_messages) == 0:
        return "Hello! How can I help you with safer routes?"

    # Build history (all but last)
    history = []
    for msg in db_messages[:-1]:
        role = "user" if msg.sender == 0 else "model"
        message_text = msg.message.strip()
        history.append(
            types.Content(
                role=role,
                parts=[types.Part(text=message_text)]
            )
        )

    # Validate + add final user turn
    last_message = db_messages[-1]
    if last_message.sender != 0:
        logger.warning(f"Last message (ID: {last_message.id}) in history is not from user. Aborting chat response.")
        return "Internal error: Expected user message to be the last one in the queue."

    history.append(
        types.Content(
            role="user",
            parts=[types.Part(text=last_message.message.strip())]
        )
    )

    # Call the Models API (supports system_instruction)
    try:
        resp = client.models.generate_content(
            model="gemini-2.5-flash",
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM_INSTRUCTION),
            contents=history,
        )
        # .text is the common convenience property; fall back if needed
        text = getattr(resp, "text", None) or getattr(resp, "output_text", None) or ""
        return text.strip() or "Sorry—got an empty reply."
    except Exception as e:
        logger.error(f"Gemini API call failed: {e}")
        raise