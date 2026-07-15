import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().email('Enter a valid email address.').toLowerCase().trim(),
  password: z.string().min(1, 'Password is required.'),
});

export const registerSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters.').trim(),
  email: z.string().email('Enter a valid email address.').toLowerCase().trim(),
  password: z.string().min(8, 'Password must be at least 8 characters.'),
  businessName: z.string().min(2, 'Business name must be at least 2 characters.').trim(),
});

export const googleAuthSchema = z.object({
  idToken: z.string().min(1, 'Google ID token is required.'),
});

export const googleSignupSchema = z.object({
  idToken: z.string().min(1, 'Google ID token is required.'),
  businessName: z.string().min(2, 'Business name must be at least 2 characters.').trim(),
});

export const createTransactionSchema = z.object({
  amount: z.number({ error: 'Amount is required.' }).positive('Amount must be positive.'),
  type: z.enum(['income', 'expense'], { error: 'Type must be income or expense.' }),
  description: z.string().min(1, 'Description is required.').trim(),
  category: z.string().optional(),
  clientId: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  date: z.string().optional(),
});

export const createClientSchema = z.object({
  name: z.string().min(1, 'Client name is required.').trim(),
  email: z.string().email('Enter a valid email.').toLowerCase().trim().optional().or(z.literal('')),
  phone: z.string().optional(),
  address: z.string().optional(),
  notes: z.string().optional(),
});

export const createInvoiceSchema = z.object({
  clientId: z.string().min(1, 'Client is required.'),
  items: z.array(z.object({
    description: z.string().min(1),
    quantity: z.number().positive(),
    unitPrice: z.number().nonnegative(),
  })).min(1, 'At least one item is required.'),
  dueDate: z.string().optional(),
  notes: z.string().optional(),
  taxRate: z.number().min(0).max(100).optional(),
});
