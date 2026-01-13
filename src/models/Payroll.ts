import mongoose, { Schema, Document } from "mongoose";

export interface IPayroll extends Document {
    businessId: mongoose.Types.ObjectId;
    staffName: string;
    salary: number;
    payday: Date;
    status: "pending" | "paid";
    staffId?: mongoose.Types.ObjectId; // Optional - can be removed if never used
}

const PayrollSchema: Schema = new Schema({
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true },
    staffName: { type: String, required: true, trim: true },
    salary: { type: Number, required: true },
    payday: { type: Date, required: true },
    status: { type: String, enum: ["pending", "paid"], default: "pending" },
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: false }, // Optional
}, { timestamps: true });

export default mongoose.model<IPayroll>("Payroll", PayrollSchema);