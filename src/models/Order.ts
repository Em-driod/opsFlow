import mongoose, { Schema, Document } from 'mongoose';

export type OrderStatus = 'pending_payment' | 'paid' | 'fulfilled' | 'cancelled';
export type PaymentSource = 'manual' | 'email_alert' | 'mono';

// Where the order is after payment, as the customer sees it.
//   placed → paid → preparing → ready (pickup) | out_for_delivery (delivery) → completed
export type OrderStage = 'placed' | 'paid' | 'preparing' | 'ready' | 'out_for_delivery' | 'completed' | 'cancelled';
export const ORDER_STAGES: OrderStage[] = ['placed', 'paid', 'preparing', 'ready', 'out_for_delivery', 'completed', 'cancelled'];

export interface IOrderProgress {
  stage: OrderStage;
  at: Date;
  note?: string;
}

export interface IOrderItem {
  productId: mongoose.Types.ObjectId;
  name: string;
  unitPrice: number;
  quantity: number;
  total: number;
}

export interface IOrder extends Document {
  businessId: mongoose.Types.ObjectId;
  // Short code the customer puts in their transfer narration, e.g. "MR7K4Q2P".
  // Doubles as the order number shown everywhere.
  code: string;
  // Unguessable token for the customer's order page (/order/:token).
  publicToken: string;
  items: IOrderItem[];
  subtotal: number;
  total: number;
  currency: string;
  customer: {
    name: string;
    phone: string;
    email?: string;
    address?: string;
  };
  deliveryMethod: 'pickup' | 'delivery';
  note?: string;
  status: OrderStatus;
  // Step-by-step history shown on the customer's order page; last entry is current.
  progress: IOrderProgress[];
  // When the customer tapped "I've sent the money" — a nudge, not proof.
  customerMarkedPaidAt?: Date;
  paidAt?: Date;
  paidAmount?: number;
  paymentSource?: PaymentSource;
  // How an automatic match was made: the code was in the narration, or the
  // amount was unique among open orders.
  matchedBy?: 'code' | 'amount' | 'manual';
  bankCreditId?: mongoose.Types.ObjectId;
  confirmedBy?: mongoose.Types.ObjectId;
  transactionId?: mongoose.Types.ObjectId;
  receiptId?: mongoose.Types.ObjectId;
  fulfilledAt?: Date;
  cancelledAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const OrderItemSchema = new Schema<IOrderItem>(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    name: { type: String, required: true },
    unitPrice: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1 },
    total: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const OrderProgressSchema = new Schema<IOrderProgress>(
  {
    stage: { type: String, enum: ORDER_STAGES, required: true },
    at: { type: Date, required: true, default: Date.now },
    note: { type: String, trim: true, maxlength: 300 },
  },
  { _id: false },
);

const OrderSchema = new Schema<IOrder>(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
    code: { type: String, required: true, unique: true },
    publicToken: { type: String, required: true, unique: true },
    items: { type: [OrderItemSchema], required: true },
    subtotal: { type: Number, required: true },
    total: { type: Number, required: true },
    currency: { type: String, default: 'NGN' },
    customer: {
      name: { type: String, required: true, trim: true },
      phone: { type: String, required: true, trim: true },
      email: { type: String, trim: true, lowercase: true },
      address: { type: String, trim: true },
    },
    deliveryMethod: { type: String, enum: ['pickup', 'delivery'], default: 'pickup' },
    note: { type: String, trim: true },
    status: {
      type: String,
      enum: ['pending_payment', 'paid', 'fulfilled', 'cancelled'],
      default: 'pending_payment',
    },
    progress: { type: [OrderProgressSchema], default: () => [{ stage: 'placed', at: new Date() }] },
    customerMarkedPaidAt: { type: Date },
    paidAt: { type: Date },
    paidAmount: { type: Number },
    paymentSource: { type: String, enum: ['manual', 'email_alert', 'mono'] },
    matchedBy: { type: String, enum: ['code', 'amount', 'manual'] },
    bankCreditId: { type: Schema.Types.ObjectId, ref: 'BankCredit' },
    confirmedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    transactionId: { type: Schema.Types.ObjectId, ref: 'Transaction' },
    receiptId: { type: Schema.Types.ObjectId, ref: 'Receipt' },
    fulfilledAt: { type: Date },
    cancelledAt: { type: Date },
  },
  { timestamps: true },
);

OrderSchema.index({ businessId: 1, status: 1, createdAt: -1 });

export default mongoose.model<IOrder>('Order', OrderSchema);
