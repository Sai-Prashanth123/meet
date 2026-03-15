from pydantic import BaseModel, EmailStr
from typing import Optional
import uuid


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class RefreshRequest(BaseModel):
    refresh_token: str


class TokenResponse(BaseModel):
    user_id: str
    token: str
    refresh_token: str


class TokenRefreshResponse(BaseModel):
    token: str


class UserResponse(BaseModel):
    user_id: str
    email: str
    created_at: str
