require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

const seedAdmin = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('MongoDB connected');

    const name = process.env.ADMIN_NAME || 'Admin';
    const email = process.env.ADMIN_EMAIL || 'admin@hkmvizag.org';
    const password = process.env.ADMIN_PASSWORD || 'admin123';

    const existingUser = await User.findOne({ email });

    if (existingUser) {
      console.log(`Admin user already exists: ${email}`);
      process.exit(0);
    }

    const user = await User.create({ name, email, password });
    console.log(`Admin user created: ${user.email}`);
    process.exit(0);
  } catch (error) {
    console.error('Error seeding admin:', error.message);
    process.exit(1);
  }
};

seedAdmin();
