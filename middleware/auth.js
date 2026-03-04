const jwt = require("jsonwebtoken");

const { readUsers } = require("../utils/storage");

const JWT_SECRET = process.env.JWT_SECRET || "aetherstream-dev-secret";

const requireAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Authorization token is required." });
    }

    const token = authHeader.slice(7).trim();

    if (!token) {
      return res.status(401).json({ message: "Authorization token is required." });
    }

    const payload = jwt.verify(token, JWT_SECRET);
    const users = await readUsers();

    const authenticatedUser = users.find((user) => user.id === payload.sub);

    if (!authenticatedUser) {
      return res.status(401).json({ message: "Invalid authentication token." });
    }

    req.user = {
      id: authenticatedUser.id,
      name: authenticatedUser.name,
      email: authenticatedUser.email,
      avatarUrl: authenticatedUser.avatarUrl || "",
    };

    next();
  } catch (error) {
    return res.status(401).json({ message: "Invalid or expired authentication token." });
  }
};

module.exports = {
  requireAuth,
  JWT_SECRET,
};
