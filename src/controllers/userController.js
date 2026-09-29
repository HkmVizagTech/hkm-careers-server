const jwt = require('jsonwebtoken');
const { validationResult, body } = require('express-validator');
const bcrypt = require('bcryptjs');
const User = require('../models/User');

/**
 * GET /api/users — list all admin accounts (passwords excluded).
 */
const list = async (req, res, next) => {
  try {
    const users = await User.find().sort({ createdAt: 1 }).select('-password');
    res.json({ users });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/users — create a new admin account.
 */
const createValidation = [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('email').isEmail().withMessage('Please provide a valid email'),
  body('password')
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters'),
];

const create = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: errors.array()[0].msg });
    }

    const { name, email, password } = req.body;

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ message: 'An admin with this email already exists' });
    }

    const user = await User.create({ name, email, password });

    res.status(201).json({
      message: 'Admin created successfully',
      user: { id: user._id, name: user.name, email: user.email, createdAt: user.createdAt },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/users/:id — remove an admin account.
 * Self-deletion is blocked so the last active admin cannot lock themselves out.
 */
const remove = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (String(req.user._id) === String(id)) {
      return res.status(400).json({ message: 'You cannot delete your own account' });
    }

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ message: 'Admin not found' });
    }

    await user.deleteOne();
    res.json({ message: 'Admin removed successfully' });
  } catch (error) {
    next(error);
  }
};

/**
 * PUT /api/users/me — update the signed-in admin's own profile.
 */
const updateMeValidation = [body('name').trim().notEmpty().withMessage('Name is required')];

const updateMe = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: errors.array()[0].msg });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.name = req.body.name;
    await user.save();

    res.json({
      message: 'Profile updated successfully',
      user: { id: user._id, name: user.name, email: user.email },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { list, create, createValidation, remove, updateMe, updateMeValidation };
