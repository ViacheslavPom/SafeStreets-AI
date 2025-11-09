from __future__ import annotations
from typing import Optional, List

from sqlalchemy import create_engine, Integer, Text, select, delete, func,DateTime
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, Session
from datetime import datetime
from zoneinfo import ZoneInfo


# ---------- ORM base & model ----------
class Base(DeclarativeBase):
    pass


class Chat(Base):
    __tablename__ = "chat"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    sender: Mapped[int] = mapped_column(Integer, nullable=False)   # 0=user, 1=assistant
    message: Mapped[str] = mapped_column(Text, nullable=False)
    timestamp = mapped_column(DateTime(timezone=True), server_default=func.now())

    def __repr__(self) -> str:
        return f"Chat(id={self.id}, sender={self.sender}, message={self.message!r})"


# ---------- setup ----------
def init_db(db_url: str = "sqlite:///chat_history.db"):
    """
    Create tables (if missing) and return an Engine.
    """
    engine = create_engine(db_url, future=True)
    Base.metadata.create_all(engine)
    return engine


def get_session(engine) -> Session:
    """
    Create a new SQLAlchemy Session bound to the engine.
    """
    return Session(engine, future=True)


def add_message(session: Session, sender: int, text: str, timestamp: datetime | None = None, limit: int = 20) -> Chat:
    """
    Insert a message. If total count exceeds `limit`, delete the oldest extras.
    Returns the inserted Chat row. <-- NOW CORRECTLY RETURNS
    """
    # Insert
    if timestamp is None:
        timestamp = datetime.now(ZoneInfo("America/New_York"))

    # Use the ORM field name 'message'
    msg = Chat(sender=sender, message=text, timestamp=timestamp)
    session.add(msg)
    session.flush()  # assigns row.id without committing

    # Enforce cap (logic unchanged, kept for brevity)
    count = session.execute(select(func.count()).select_from(Chat)).scalar_one()
    if count > limit:
        to_delete = count - limit
        del_stmt = delete(Chat).where(
            Chat.id.in_(
                select(Chat.id).order_by(Chat.id.asc()).limit(to_delete)
            )
        )
        session.execute(del_stmt)

    session.commit()
    session.refresh(msg)
    return msg # <-- CRITICAL FIX: Return the newly created message object


def get_last_message(session: Session) -> Optional[Chat]:
    """
    Return the most recent Chat row or None.
    """
    return session.execute(
        select(Chat).order_by(Chat.id.desc()).limit(1)
    ).scalar_one_or_none()


def get_all_messages(session: Session) -> List[Chat]:
    """
    Return all Chat rows (unordered). For chronological order, add ORDER BY id ASC.
    """
    return list(session.execute(select(Chat).order_by(Chat.id.asc())).scalars().all())


def drop_chat_table(engine):
    """
    Drop the 'chat' table if it exists.
    """
    Chat.__table__.drop(engine, checkfirst=True)
    print("Dropped table 'chat'.")


def recreate_chat_table(engine):
    """
    Drop and recreate the 'chat' table.
    """
    drop_chat_table(engine)
    Base.metadata.create_all(engine, tables=[Chat.__table__])
    print("Recreated table 'chat'.")


def get_recent_rows(session: Session, n=20) -> List[Chat]:

    rows = list(session.execute(
        select(Chat).order_by(Chat.id.desc()).limit(n)
    ).scalars().all())
    rows.reverse()
    return rows


def message_history(session: Session, n=20, system_prompt: str | None = None) -> List[dict]:
    msgs: List[dict] = []
    if system_prompt:
        msgs.append({"role": "system", "content": system_prompt})

    for r in get_recent_rows(session, n):
        role = "user" if r.sender == 0 else "system"
        msgs.append({"role": role, "content": r.message})
    return msgs


if __name__ == "__main__":
    engine = init_db()
    # recreate_chat_table(engine)  #UNCOMMIT IF YOU WANT TO RECREATE A DB