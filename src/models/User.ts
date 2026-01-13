import mongoose, { Schema, Document } from "mongoose";

export interface IUser extends Document {
    name: string;
    role: "admin" | "staff";
    email: string;
    password: string;
    businessId: mongoose.Types.ObjectId;
}

const UserSchema: Schema = new Schema({
    name: { type: String, required: true },
    role: { type: String, enum: ["admin", "staff"], required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true },
}, { timestamps: true });

export default mongoose.model<IUser>("User", UserSchema);