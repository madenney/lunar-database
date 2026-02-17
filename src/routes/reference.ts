import { Router, Request, Response } from "express";
import { stages, characters } from "@slippi/slippi-js";

const router = Router();

// GET /api/reference/characters — all character IDs and names
router.get("/characters", (_req: Request, res: Response) => {
  const allCharacters = characters.getAllCharacters();
  res.json(allCharacters);
});

// GET /api/reference/stages — all stage IDs and names
router.get("/stages", (_req: Request, res: Response) => {
  const allStages = stages.getStages();
  res.json(allStages);
});

export default router;
