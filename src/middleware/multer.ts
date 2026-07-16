import multer, { type FileFilterCallback } from 'multer';
import type { Request } from 'express';

// Configure multer for memory storage to handle file as buffer
const storage = multer.memoryStorage();

// Filter to allow only image files
const fileFilter = (_req: Request, file: Express.Multer.File, cb: FileFilterCallback) => {
  if (file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new Error('Not an image! Please upload an image file.'));
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 1024 * 1024 * 5 }, // 5MB file size limit
});

export default upload;
