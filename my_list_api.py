"""
my_list_api.py
---------------------------------------------------------------------------
FastAPI endpoints for the "My List" panel. Storage lives in my_list_db.py.

Wire it into app.py (two lines):

    from my_list_api import router as my_list_router
    app.include_router(my_list_router)

The tables are created in the master DB on import (CREATE TABLE IF NOT
EXISTS), so nothing else is needed.

The UI sends the logged-in Keycloak username in the X-User header
(URL-encoded); lists and views are stored per user, while
employee_interview_status is shared by everyone.

Endpoints (all under /my-list):
    GET    /my-list                          lists + items + employee status
    POST   /my-list                          add a query result as a new list
    DELETE /my-list/{list_id}                delete a whole list
    POST   /my-list/{list_id}/interviewed    mark all (or given) items interviewed
    DELETE /my-list/items/{item_id}          remove one candidate
    POST   /my-list/items/{item_id}/interviewed
    GET    /my-list/employee-status/{employee_number}
    GET    /my-list/views
    POST   /my-list/views                    create / overwrite by name
    DELETE /my-list/views/{view_id}
---------------------------------------------------------------------------
"""

from typing import Any, Dict, List, Optional
from urllib.parse import unquote

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

import my_list_db

my_list_db.init_my_list_tables()

router = APIRouter(prefix="/my-list", tags=["my-list"])


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class AddToListRequest(BaseModel):
    query: Optional[str] = None
    sql: Optional[str] = None
    columns: List[str]
    rows: List[List[Any]]


class MarkListRequest(BaseModel):
    item_ids: Optional[List[int]] = None


class SaveViewRequest(BaseModel):
    name: str
    config: Dict[str, Any] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _owner(x_user: Optional[str]) -> str:
    return unquote(x_user or "").strip() or "default"


def _run(fn, *args):
    try:
        return fn(*args)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ---------------------------------------------------------------------------
# Saved views (declared before /{list_id} routes)
# ---------------------------------------------------------------------------

@router.get("/views")
def list_views(x_user: Optional[str] = Header(default=None)):
    return _run(my_list_db.get_views, _owner(x_user))


@router.post("/views")
def save_view(body: SaveViewRequest, x_user: Optional[str] = Header(default=None)):
    return _run(my_list_db.save_view, _owner(x_user), body.name, body.config)


@router.delete("/views/{view_id}")
def delete_view(view_id: int, x_user: Optional[str] = Header(default=None)):
    return _run(my_list_db.delete_view, _owner(x_user), view_id)


# ---------------------------------------------------------------------------
# Employee status
# ---------------------------------------------------------------------------

@router.get("/employee-status/{employee_number}")
def employee_status(employee_number: str):
    status = my_list_db.get_employee_status(employee_number)
    if status is None:
        raise HTTPException(status_code=404, detail="Employee has no tracking status yet.")
    return status


# ---------------------------------------------------------------------------
# List items
# ---------------------------------------------------------------------------

@router.delete("/items/{item_id}")
def remove_item(item_id: int, x_user: Optional[str] = Header(default=None)):
    return _run(my_list_db.remove_item, _owner(x_user), item_id)


@router.post("/items/{item_id}/interviewed")
def mark_item_interviewed(item_id: int, x_user: Optional[str] = Header(default=None)):
    return _run(my_list_db.mark_item_interviewed, _owner(x_user), item_id)


# ---------------------------------------------------------------------------
# Lists
# ---------------------------------------------------------------------------

@router.get("")
def read_my_list(x_user: Optional[str] = Header(default=None)):
    return _run(my_list_db.get_my_list, _owner(x_user))


@router.post("")
def add_to_my_list(body: AddToListRequest, x_user: Optional[str] = Header(default=None)):
    return _run(
        my_list_db.create_list,
        _owner(x_user), body.query, body.sql, body.columns, body.rows,
    )


@router.post("/{list_id}/interviewed")
def mark_list_interviewed(
    list_id: int,
    body: Optional[MarkListRequest] = None,
    x_user: Optional[str] = Header(default=None),
):
    item_ids = body.item_ids if body else None
    return _run(my_list_db.mark_list_interviewed, _owner(x_user), list_id, item_ids)


@router.delete("/{list_id}")
def delete_list(list_id: int, x_user: Optional[str] = Header(default=None)):
    return _run(my_list_db.delete_list, _owner(x_user), list_id)
