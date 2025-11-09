# main.py (FULL FIXED)
from fastapi import FastAPI, Depends, HTTPException, Response, status, Request
from functools import lru_cache
import os
import pandas as pd
from fastapi.middleware.cors import CORSMiddleware
import a_star_v2
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
# Assuming database_s.py and Chat model are correctly implemented
from database_s import init_db, get_session, add_message, get_all_messages
from typing import List, Optional
from zoneinfo import ZoneInfo
from datetime import datetime
from sqlalchemy.orm import Session
from gemini import get_gemini_response

app = FastAPI(title="SafeStreets")

EDGES_PATH = "../ml/data/data_backend/edges_table.parquet"
try:
    edges_df = pd.read_parquet(EDGES_PATH)
except Exception as e:
    print(f"WARNING: Could not load edges_df from {EDGES_PATH}. Error: {e}")
    edges_df = pd.DataFrame()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class RouteIn(BaseModel):
    from_: list[float] = Field(alias="from", min_items=2, max_items=2)
    to: list[float] = Field(min_items=2, max_items=2)


def _build_payload():
    results = []
    if edges_df.empty:
        return []

    for _, row in edges_df.iterrows():
        results.append({"from": [row["start_lat"], row["start_lon"]], "to": [row["end_lat"], row["end_lon"]],
                        "risk_score": row["risk_score"]})
    return results


@lru_cache(maxsize=1)
def _cached_payload():
    df = pd.read_parquet(EDGES_PATH)
    return _build_payload()


@app.get("/heatmap")
def get_edges_risks(nocache: bool = False):
    if nocache:
        df = pd.read_parquet(EDGES_PATH)
        payload = _build_payload()
    else:
        payload = _cached_payload()

    return payload


@app.get("/")
def index():
    return "hi"


@app.post("/route")
async def route_handler(request: Request):
    data = await request.json()

    if not data or "from" not in data or "to" not in data:
        return JSONResponse(
            {"error": "Expected JSON body with fields 'from' and 'to'"},
            status_code=400
        )
    start_lat = data["from"][0]
    start_lon = data["from"][1]

    # CRITICAL FIX: Use data["to"] for the end coordinates
    end_lat = data["to"][0]
    end_lon = data["to"][1]

    NODES_PATH = "../ml/data/data_backend/nodes_table.parquet"
    EDGES_PATH = "../ml/data/data_backend/edges_table.parquet"

    edges_df = pd.read_parquet(EDGES_PATH)
    nodes_df = pd.read_parquet(NODES_PATH)

    result = a_star_v2.safest_route_between_coords(
        nodes_df, edges_df,
        start_lat, start_lon,
        end_lat, end_lon,
        undirected=True,  # set False if edges are directed
        attach_even_if_far_m=25.0,  # tweak if your edges/nodes are a bit misaligned
    )
    return ({"path": result})


"-----------------"
"Gemini client"

engine = init_db()


# Dependency to get DB session
def db_dep():
    with get_session(engine) as session:
        yield session


# ---------------- Pydantic Schemas ----------------
class MessageIn(BaseModel):
    message: str = Field(..., min_length=1)
    persona: Optional[str] = None


class MessageOut(BaseModel):
    id: int
    sender: int
    message: str
    timestamp: datetime

    class Config:
        from_attributes = True


@app.get("/api/chat", response_model=List[MessageOut])
def list_messages(db: Session = Depends(db_dep)):
    """Fetches all messages from the database."""
    rows = get_all_messages(db)
    return [MessageOut.model_validate(r) for r in rows]


@app.post("/api/chat")
def chat(payload: MessageIn, db: Session = Depends(db_dep)):
    """
    Receives a user message, stores it, asks Gemini for a response
    using the entire chat history, stores the response, and returns 204.
    """
    now = datetime.now(ZoneInfo("America/New_York"))
    user_text = payload.message.strip()

    if not user_text:
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    # 1. Retrieve the ENTIRE history, filtering out any None values.
    chat_history_for_gemini = [
        msg for msg in get_all_messages(db) if msg is not None
    ]

    # 2. Add the NEW user message to the database
    new_user_msg = add_message(db, sender=0, text=user_text, timestamp=now)

    if not new_user_msg:
        raise HTTPException(status_code=500, detail="Failed to record user message.")

    chat_history_for_gemini.append(new_user_msg)

    # 3. Get Gemini's response using the full history
    assistant_text: str = ""
    try:
        assistant_text = get_gemini_response(chat_history_for_gemini)
    except Exception as e:
        import traceback
        print(f"--- Chat processing error ---")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"AI model service failed: {e}")

    # 4. Record Gemini's answer
    assistant_now = datetime.now(ZoneInfo("America/New_York"))
    add_message(db, sender=1, text=assistant_text, timestamp=assistant_now)

    return Response(status_code=status.HTTP_204_NO_CONTENT)

# if __name__ == "__main__":
#     import uvicorn
#     uvicorn.run(
#         app,
#         host="0.0.0.0",
#         port=8000
#     )