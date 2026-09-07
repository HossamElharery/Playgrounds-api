-- Mal3ab gaming expansion — stable bracket position for TournamentMatch.
ALTER TABLE "TournamentMatch" ADD COLUMN     "matchIndex" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "TournamentMatch_tournamentId_round_matchIndex_key" ON "TournamentMatch"("tournamentId", "round", "matchIndex");
