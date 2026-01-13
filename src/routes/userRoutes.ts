import express from "express";
const router = express.Router();
import {
    registerUser,
    loginUser,
    getUsers,
    getUserById,
    updateUser,
    deleteUser,
} from "../controllers/userController.js";
import { protect, admin } from "../middleware/auth.js";

router.route("/").get(protect, admin, getUsers);
router.post("/register", registerUser);
router.post("/login", loginUser);
router.route("/:id").get(protect, getUserById).put(protect, updateUser).delete(protect, admin, deleteUser);

export default router;
