from db.models import Order
from services.money import to_cents

def list_orders():
    return [{"id": o.id, "total": to_cents(o.total)} for o in Order.all()]
