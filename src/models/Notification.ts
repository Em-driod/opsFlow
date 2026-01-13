import mongoose, { Schema, Document } from "mongoose";

export interface INotification extends Document {
    businessId: mongoose.Types.ObjectId;
    userId: mongoose.Types.ObjectId;
    message: string;
    isRead: boolean;
    link?: string;
}

const NotificationSchema: Schema = new Schema({
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    message: { type: String, required: true },
    isRead: { type: Boolean, default: false, required: true },
    link: { type: String },
}, { timestamps: true });

export default mongoose.model<INotification>("Notification", NotificationSchema);
