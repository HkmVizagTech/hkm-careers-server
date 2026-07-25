const { validationResult, body } = require('express-validator');
const Department = require('../models/Department');
const Job = require('../models/Job');

const createValidation = [
  body('name').notEmpty().withMessage('Department name is required').trim(),
];

const getAll = async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.active === 'true') {
      filter.isActive = true;
    }

    const departments = await Department.find(filter).sort({ name: 1 });
    res.json(departments);
  } catch (error) {
    next(error);
  }
};

const getById = async (req, res, next) => {
  try {
    const department = await Department.findById(req.params.id);
    if (!department) {
      return res.status(404).json({ message: 'Department not found' });
    }
    res.json(department);
  } catch (error) {
    next(error);
  }
};

const create = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: errors.array()[0].msg });
    }

    const department = await Department.create(req.body);
    res.status(201).json(department);
  } catch (error) {
    next(error);
  }
};

const update = async (req, res, next) => {
  try {
    const department = await Department.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });

    if (!department) {
      return res.status(404).json({ message: 'Department not found' });
    }

    res.json(department);
  } catch (error) {
    next(error);
  }
};

const remove = async (req, res, next) => {
  try {
    const activeJobs = await Job.countDocuments({
      department: req.params.id,
      status: 'active',
    });

    if (activeJobs > 0) {
      return res.status(400).json({
        message: 'Cannot delete department with active jobs. Close or reassign jobs first.',
      });
    }

    const department = await Department.findByIdAndDelete(req.params.id);
    if (!department) {
      return res.status(404).json({ message: 'Department not found' });
    }

    res.json({ message: 'Department deleted successfully' });
  } catch (error) {
    next(error);
  }
};

module.exports = { getAll, getById, create, createValidation, update, remove };
