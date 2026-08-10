import 'dotenv/config';
import mongoose from 'mongoose';
import Employee from '../models/Employee.js';
import { connectDB } from '../config/db.js';

const password = process.argv[2] || 'hrms@123';

await connectDB();
const users = await Employee.find({}).select('+password email role name');
let updated = 0;
for (const user of users) {
  user.password = password;
  await user.save();
  updated++;
}
console.log(`Updated ${updated} users to password: ${password}`);

const admins = await Employee.find({ role: 'admin' }).select('email').lean();
const hrs = await Employee.find({ role: 'hr' }).select('email').lean();
const emp = await Employee.findOne({ role: 'employee' }).select('email').lean();
console.log('Sample logins:');
admins.forEach((u) => console.log(`  admin: ${u.email}`));
hrs.forEach((u) => console.log(`  hr: ${u.email}`));
if (emp) console.log(`  employee: ${emp.email}`);

await mongoose.disconnect();
