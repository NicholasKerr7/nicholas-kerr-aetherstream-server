const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const { readUsers, writeUsers } = require("../utils/storage");
const { requireAuth, JWT_SECRET } = require("../middleware/auth");

const router = express.Router();
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

const sanitizeUser = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  avatarUrl: user.avatarUrl || "",
  createdAt: user.createdAt,
});

const signTokenForUser = (user) =>
  jwt.sign(
    {
      sub: user.id,
      email: user.email,
      name: user.name,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );

router.post("/signup", async (req, res) => {
  try {
    const name = req.body.name?.trim();
    const email = req.body.email?.trim().toLowerCase();
    const password = req.body.password || "";
    const avatarUrl = req.body.avatarUrl?.trim() || "";

    if (!name || !email || password.length < 8) {
      return res.status(400).json({
        message:
          "Please provide a name, valid email, and password with at least 8 characters.",
      });
    }

    const users = await readUsers();

    if (users.some((user) => user.email === email)) {
      return res.status(409).json({ message: "An account with this email already exists." });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const newUser = {
      id: crypto.randomUUID(),
      name,
      email,
      passwordHash,
      avatarUrl,
      createdAt: Date.now(),
    };

    users.push(newUser);
    await writeUsers(users);

    const token = signTokenForUser(newUser);

    return res.status(201).json({
      token,
      user: sanitizeUser(newUser),
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to create account." });
  }
});

router.post("/login", async (req, res) => {
  try {
    const email = req.body.email?.trim().toLowerCase();
    const password = req.body.password || "";

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required." });
    }

    const users = await readUsers();
    const existingUser = users.find((user) => user.email === email);

    if (!existingUser) {
      return res.status(401).json({ message: "Invalid email or password." });
    }

    const passwordMatches = await bcrypt.compare(password, existingUser.passwordHash);

    if (!passwordMatches) {
      return res.status(401).json({ message: "Invalid email or password." });
    }

    const token = signTokenForUser(existingUser);

    return res.json({
      token,
      user: sanitizeUser(existingUser),
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to sign in." });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  try {
    const users = await readUsers();
    const existingUser = users.find((user) => user.id === req.user.id);

    if (!existingUser) {
      return res.status(404).json({ message: "User profile not found." });
    }

    return res.json(sanitizeUser(existingUser));
  } catch (error) {
    return res.status(500).json({ message: "Failed to load profile." });
  }
});

router.patch("/me", requireAuth, async (req, res) => {
  try {
    const users = await readUsers();
    const existingUser = users.find((user) => user.id === req.user.id);

    if (!existingUser) {
      return res.status(404).json({ message: "User profile not found." });
    }

    const nextName = req.body.name?.trim();
    const nextAvatarUrl = req.body.avatarUrl?.trim();

    if (typeof nextName === "string" && nextName.length > 0) {
      existingUser.name = nextName;
    }

    if (typeof nextAvatarUrl === "string") {
      existingUser.avatarUrl = nextAvatarUrl;
    }

    await writeUsers(users);

    return res.json(sanitizeUser(existingUser));
  } catch (error) {
    return res.status(500).json({ message: "Failed to update profile." });
  }
});

module.exports = router;
