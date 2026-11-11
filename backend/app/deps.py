"""Shared FastAPI dependencies."""

from typing import Annotated

from fastapi import Depends, HTTPException, Query, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from .db import get_session
from .models import User
from .security import decode_access_token

_bearer = HTTPBearer(auto_error=False)

SessionDep = Annotated[AsyncSession, Depends(get_session)]


async def _user_from_token(token: str | None, session: AsyncSession) -> User:
    unauthorized = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Not authenticated",
        headers={"WWW-Authenticate": "Bearer"},
    )
    if not token:
        raise unauthorized
    user_id = decode_access_token(token)
    if user_id is None:
        raise unauthorized
    user = await session.get(User, user_id)
    if user is None:
        raise unauthorized
    return user


async def get_current_user(
    session: SessionDep,
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)] = None,
) -> User:
    return await _user_from_token(creds.credentials if creds else None, session)


async def get_current_user_media(
    session: SessionDep,
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)] = None,
    access_token: Annotated[str | None, Query()] = None,
) -> User:
    """Like get_current_user, but also accepts ?access_token= for media URLs.

    Browsers cannot attach an Authorization header to <img> or <video> requests, so
    the web client passes the short-lived access token in the query string instead.
    """
    token = creds.credentials if creds else access_token
    return await _user_from_token(token, session)


CurrentUser = Annotated[User, Depends(get_current_user)]
MediaUser = Annotated[User, Depends(get_current_user_media)]
