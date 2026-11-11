"""Login, token refresh and account endpoints."""

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import select, update

from ..config import get_settings
from ..deps import CurrentUser, SessionDep
from ..metrics import LOGIN_ATTEMPTS
from ..models import RefreshToken, User
from ..ratelimit import RateLimiter
from ..schemas import LoginIn, PasswordChangeIn, RefreshIn, TokenPair, UserOut
from ..security import (
    DUMMY_HASH,
    create_access_token,
    hash_password,
    hash_refresh_token,
    new_refresh_token,
    verify_password,
)

router = APIRouter(prefix="/api", tags=["auth"])

_settings = get_settings()
login_limiter = RateLimiter(_settings.login_rate_limit, _settings.login_rate_window_s)


async def _issue_tokens(session, user: User) -> TokenPair:
    access, expires_in = create_access_token(user.id)
    raw, token_hash = new_refresh_token()
    session.add(
        RefreshToken(
            user_id=user.id,
            token_hash=token_hash,
            expires_at=datetime.now(UTC) + timedelta(days=get_settings().refresh_token_days),
        )
    )
    await session.commit()
    return TokenPair(access_token=access, refresh_token=raw, expires_in=expires_in)


@router.post("/auth/login", response_model=TokenPair)
async def login(body: LoginIn, request: Request, session: SessionDep) -> TokenPair:
    email = body.email.strip().lower()
    client_ip = request.client.host if request.client else "unknown"
    key = f"{client_ip}|{email}"

    wait = login_limiter.retry_after(key)
    if wait:
        LOGIN_ATTEMPTS.labels("rate_limited").inc()
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many login attempts. Try again shortly.",
            headers={"Retry-After": str(wait)},
        )

    user = await session.scalar(select(User).where(User.email == email))
    # Always run a hash verification so unknown emails are not faster to reject.
    valid = verify_password(body.password, user.password_hash if user else DUMMY_HASH)
    if user is None or not valid:
        login_limiter.record(key)
        LOGIN_ATTEMPTS.labels("failed").inc()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect email or password"
        )

    login_limiter.reset(key)
    LOGIN_ATTEMPTS.labels("ok").inc()
    return await _issue_tokens(session, user)


@router.post("/auth/refresh", response_model=TokenPair)
async def refresh(body: RefreshIn, session: SessionDep) -> TokenPair:
    invalid = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token"
    )
    now = datetime.now(UTC)
    row = await session.scalar(
        select(RefreshToken).where(
            RefreshToken.token_hash == hash_refresh_token(body.refresh_token)
        )
    )
    if row is None:
        raise invalid
    if row.expires_at <= now or row.revoked_at is not None:
        raise invalid
    if row.rotated_at is not None:
        grace = timedelta(seconds=get_settings().refresh_reuse_grace_s)
        if now - row.rotated_at > grace:
            # An old, already-rotated token was presented: assume it leaked and end
            # every session for this account.
            await session.execute(
                update(RefreshToken)
                .where(RefreshToken.user_id == row.user_id, RefreshToken.revoked_at.is_(None))
                .values(revoked_at=now)
            )
            await session.commit()
            raise invalid
        # Within the grace window this is a retry, not theft: issue a fresh pair.
    else:
        row.rotated_at = now
    user = await session.get(User, row.user_id)
    if user is None:
        raise invalid
    return await _issue_tokens(session, user)


@router.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(body: RefreshIn, session: SessionDep) -> None:
    await session.execute(
        update(RefreshToken)
        .where(
            RefreshToken.token_hash == hash_refresh_token(body.refresh_token),
            RefreshToken.revoked_at.is_(None),
        )
        .values(revoked_at=datetime.now(UTC))
    )
    await session.commit()


@router.get("/me", response_model=UserOut)
async def me(user: CurrentUser) -> User:
    return user


@router.post("/me/password", status_code=status.HTTP_204_NO_CONTENT)
async def change_password(body: PasswordChangeIn, user: CurrentUser, session: SessionDep) -> None:
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="Current password is incorrect")
    user.password_hash = hash_password(body.new_password)
    # Changing the password signs out every other session.
    await session.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=datetime.now(UTC))
    )
    await session.commit()
