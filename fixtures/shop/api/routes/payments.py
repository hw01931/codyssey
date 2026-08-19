from fastapi import APIRouter, Body
from services.payment import charge

router = APIRouter()

@router.post("/payments")
def post_payment(amount: float = Body(..., embed=True, gt=0)):
    return charge(amount)
