import Employee from '../models/Employee.js';
import { signToken } from '../middleware/auth.js';

export async function login(req, res) {
  try {
    const { email, password } = req.body;
    const user = await Employee.findOne({ email: (email || '').toLowerCase() }).select('+password').populate('department_id');
    if (!user) return res.status(401).json({ message: 'Invalid credentials' });
    const ok = await user.comparePassword(password || '');
    if (!ok) return res.status(401).json({ message: 'Invalid credentials' });
    if (user.status !== 'active') return res.status(403).json({ message: 'Account inactive' });
    const token = signToken(user);
    const json = user.toJSON();
    res.json({ token, user: json });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function me(req, res) {
  res.json({ user: req.user });
}

export async function changePassword(req, res) {
  try {
    const { current_password, new_password } = req.body;
    const user = await Employee.findById(req.user._id).select('+password');
    if (!(await user.comparePassword(current_password || ''))) {
      return res.status(400).json({ message: 'Current password incorrect' });
    }
    if (!new_password || new_password.length < 6) {
      return res.status(400).json({ message: 'New password must be at least 6 characters' });
    }
    user.password = new_password;
    await user.save();
    res.json({ message: 'Password updated' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}
