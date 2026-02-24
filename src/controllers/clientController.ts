import type { Request, Response } from 'express';
import Client from '../models/Client.js';
import Business from '../models/Business.js';

// @desc    Create a new client
// @route   POST /api/clients
// @access  Private
export const createClient = async (req: Request, res: Response) => {
  try {
    const { name, email, phone, businessValue, status } = req.body;

    const client = await Client.create({
      name,
      email,
      phone,
      businessValue,
      status,
      businessId: (req.user as any).businessId, // Associate with the user's business
    });

    res.status(201).json(client);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
    console.error('Error creating client:', error);
  }
};

// @desc    Get all clients for a business
// @route   GET /api/clients
// @access  Private
export const getClients = async (req: Request, res: Response) => {
  try {
    const clients = await Client.find({ businessId: (req.user as any).businessId }); // Filter by businessId
    res.json(clients);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
    console.error('Error fetching clients:', error);
  }
};

// @desc    Get client by ID
// @route   GET /api/clients/:id
// @access  Private
export const getClientById = async (req: Request, res: Response) => {
  try {
    const client = await Client.findOne({
      _id: req.params.id,
      businessId: (req.user as any).businessId,
    }).populate('transactions'); // Filter by businessId
    if (client) {
      res.json(client);
    } else {
      res.status(404).json({ message: 'Client not found' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
    console.error('Error fetching client by ID:', error);
  }
};

// @desc    Update client
// @route   PUT /api/clients/:id
// @access  Private
export const updateClient = async (req: Request, res: Response) => {
  try {
    const client = await Client.findOne({
      _id: req.params.id,
      businessId: (req.user as any).businessId,
    }); // Filter by businessId
    if (client) {
      client.name = req.body.name || client.name;
      client.email = req.body.email || client.email;
      client.phone = req.body.phone || client.phone;
      client.businessValue = req.body.businessValue || client.businessValue;
      client.status = req.body.status || client.status;
      // Removed logic to update businessId, as it should be tied to the user and immutable here.
      // if (req.body.businessId !== undefined) {
      //     client.businessId = req.body.businessId;
      // }

      const updatedClient = await client.save();
      res.json(updatedClient);
    } else {
      res.status(404).json({ message: 'Client not found' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
    console.error('Error updating client:', error);
  }
};

// @desc    Delete client
// @route   DELETE /api/clients/:id
// @access  Private
export const deleteClient = async (req: Request, res: Response) => {
  try {
    const client = await Client.findOne({
      _id: req.params.id,
      businessId: (req.user as any).businessId,
    }); // Filter by businessId
    if (client) {
      await client.deleteOne();
      res.json({ message: 'Client removed' });
    } else {
      res.status(404).json({ message: 'Client not found' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: (error as Error).message });
    console.error('Error deleting client:', error);
  }
};
