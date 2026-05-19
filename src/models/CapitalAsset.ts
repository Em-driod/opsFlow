import mongoose, { Schema, Document } from 'mongoose';
import type { AssetClass } from '../services/nigerianTax.js';

export interface ICapitalAsset extends Document {
  businessId: mongoose.Types.ObjectId;
  name: string;
  assetClass: AssetClass;
  cost: number;
  acquiredOn: Date;
  disposedOn?: Date;
  notes?: string;
  createdBy: mongoose.Types.ObjectId;
}

const ASSET_CLASSES: AssetClass[] = [
  'industrial_building',
  'non_industrial_building',
  'plant_machinery',
  'furniture_fittings',
  'motor_vehicle',
  'office_equipment',
  'computer_equipment',
];

const CapitalAssetSchema: Schema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    name: { type: String, required: true },
    assetClass: { type: String, enum: ASSET_CLASSES, required: true },
    cost: { type: Number, required: true, min: 0 },
    acquiredOn: { type: Date, required: true },
    disposedOn: { type: Date },
    notes: { type: String },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

export default mongoose.model<ICapitalAsset>('CapitalAsset', CapitalAssetSchema);
