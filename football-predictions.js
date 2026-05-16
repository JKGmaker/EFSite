// netlify/functions/football-predictions.js
//
// Football match prediction engine
// Covers: Premier League, Championship, League 1, League 2
//
// Markets scored per fixture:
//   BTTS      — Both Teams to Score
//   OVER25    — Over 2.5 Goals
//   HOME_WIN  — Home team win
//   AWAY_WIN  — Away team win
//   DRAW      — Draw
//
// Confidence tiers:
//   BANKER     80+   ⭐  High confidence — lead pick of the day
//   VALUE PLAY 68–79 💡  Good value — include in accas
//   LONGSHOT   55–67 🎯  Speculative — small stakes only
//   Hidden     <55        Not shown

const LEAGUE_IDS = {
  "Premier League": 39,
  "Championship":   40,
  "League 1":       41,
  "League 2":       42,
};

const SEASON = new Date().getFullYear(); // or pin to 2024

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders(), body: "" };
  }

  const apiKey = process.env.FOOTBALL_API_KEY; // api-football.com key
  if (!apiKey) {
    return jsonResponse(401, { error: "NOT_CONFIGURED", message: "FOOTBALL_API_KEY env var not set." });
  }

  const params = event.queryStringParameters || {};
  const debug = params.debug === "1";
  const leagueFilter = params.league; // optional: filter to one league name
  const dateParam = params.date || todayStr();

  const authHeaders = {
    "x-rapidapi-key": apiKey,
    "x-rapidapi-host": "v3.football.api-sports.io",
  };

  try {
    // ── Fetch fixtures for each league ────────────────────────────────────
    const leagueEntries = Object.entries(LEAGUE_IDS).filter(
      ([name]) => !leagueFilter || name.toLowerCase() === leagueFilter.toLowerCase()
    );

    const fixtureResults = await Promise.allSettled(
      leagueEntries.map(([leagueName, leagueId]) =>
        fetchFixtures(apiKey, authHeaders, leagueId, SEASON, dateParam).then((fixtures) => ({
          leagueName,
          leagueId,
          fixtures,
        }))
      )
    );

    const allFixtures = [];
    const errors = [];

    fixtureResults.forEach((r) => {
      if (r.status === "fulfilled") {
        allFixtures.push(...r.value.fixtures.map((f) => ({ ...f, leagueName: r.value.leagueName })));
      } else {
        errors.push(r.reason?.message || "Unknown error");
      }
    });

    if (debug) {
      return jsonResponse(200, {
        debug: true,
        date: dateParam,
        total_fixtures_fetched: allFixtures.length,
        api_errors: errors,
        sample: allFixtures.slice(0, 3).map((f) => ({
          id: f.fixture?.id,
          home: f.teams?.home?.name,
          away: f.teams?.away?.name,
          league: f.leagueName,
          date: f.fixture?.date,
        })),
      });
    }

    // ── Score every fixture ───────────────────────────────────────────────
    const predictions = [];

    for (const fixture of allFixtures) {
      // We need H2H + team stats — fetch in parallel per fixture
      const fixtureId = fixture.fixture?.id;
      const homeId    = fixture.teams?.home?.id;
      const awayId    = fixture.teams?.away?.id;
      const leagueId  = fixture.league?.id;

      if (!fixtureId || !homeId || !awayId) continue;

      const [h2h, homeStats, awayStats, odds] = await Promise.allSettled([
        fetchH2H(apiKey, authHeaders, homeId, awayId),
        fetchTeamStats(apiKey, authHeaders, leagueId, SEASON, homeId),
        fetchTeamStats(apiKey, authHeaders, leagueId, SEASON, awayId),
        fetchOdds(apiKey, authHeaders, fixtureId),
      ]).then((r) => r.map((x) => (x.status === "fulfilled" ? x.value : null)));

      const result = scoreFixture(fixture, h2h, homeStats, awayStats, odds);
      if (result) predictions.push(result);
    }

    // Sort: highest confidence first, then by kick-off time
    predictions.sort((a, b) => {
      if (b.topMarket.score !== a.topMarket.score) return b.topMarket.score - a.topMarket.score;
      return (a.kickoff || "").localeCompare(b.kickoff || "");
    });

    // Segment by bet tier
    const bankers    = predictions.filter((p) => p.topMarket.tier === "BANKER");
    const valuePlays = predictions.filter((p) => p.topMarket.tier === "VALUE PLAY");
    const longshots  = predictions.filter((p) => p.topMarket.tier === "LONGSHOT");

    return jsonResponse(200, {
      generated_at: new Date().toISOString(),
      date: dateParam,
      total_fixtures: predictions.length,
      bankers_count: bankers.length,
      value_plays_count: valuePlays.length,
      longshots_count: longshots.length,
      api_errors: errors,
      predictions,
    });
  } catch (err) {
    return jsonResponse(500, { error: "FETCH_FAILED", message: err.message });
  }
};

// ── API helpers ───────────────────────────────────────────────────────────────

async function fetchFixtures(apiKey, headers, leagueId, season, date) {
  const url = `https://v3.football.api-sports.io/fixtures?league=${leagueId}&season=${season}&date=${date}`;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`Fixtures HTTP ${r.status} league ${leagueId}`);
  const data = await r.json();
  return data.response || [];
}

async function fetchH2H(apiKey, headers, homeId, awayId) {
  const url = `https://v3.football.api-sports.io/fixtures/headtohead?h2h=${homeId}-${awayId}&last=10`;
  const r = await fetch(url, { headers });
  if (!r.ok) return null;
  const data = await r.json();
  return data.response || [];
}

async function fetchTeamStats(apiKey, headers, leagueId, season, teamId) {
  const url = `https://v3.football.api-sports.io/teams/statistics?league=${leagueId}&season=${season}&team=${teamId}`;
  const r = await fetch(url, { headers });
  if (!r.ok) return null;
  const data = await r.json();
  return data.response || null;
}

async function fetchOdds(apiKey, headers, fixtureId) {
  const url = `https://v3.football.api-sports.io/odds?fixture=${fixtureId}&bookmaker=6`; // bet365
  const r = await fetch(url, { headers });
  if (!r.ok) return null;
  const data = await r.json();
  return data.response?.[0] || null;
}

// ── Scoring engine ────────────────────────────────────────────────────────────

function scoreFixture(fixture, h2h, homeStats, awayStats, oddsData) {
  const homeName = fixture.teams?.home?.name || "Home";
  const awayName = fixture.teams?.away?.name || "Away";

  // Derived stats
  const home = deriveStats(homeStats, "home");
  const away = deriveStats(awayStats, "away");
  const h2hStats = deriveH2H(h2h, fixture.teams?.home?.id);

  // ── Market scores ─────────────────────────────────────────────────────
  const markets = {
    BTTS:      scoreBTTS(home, away, h2hStats),
    OVER25:    scoreOver25(home, away, h2hStats),
    HOME_WIN:  scoreHomeWin(home, away, h2hStats),
    AWAY_WIN:  scoreAwayWin(home, away, h2hStats),
    DRAW:      scoreDraw(home, away, h2hStats),
  };

  // Pick the single best-scoring market
  const topMarketKey = Object.entries(markets).sort((a, b) => b[1] - a[1])[0][0];
  const topScore = markets[topMarketKey];

  // Hide low-confidence fixtures
  if (topScore < 55) return null;

  // All markets with their tiers (only include those ≥55)
  const allMarkets = Object.entries(markets)
    .filter(([, score]) => score >= 55)
    .map(([key, score]) => ({ market: key, score, ...getTier(score) }))
    .sort((a, b) => b.score - a.score);

  // Parse odds for the top market
  const oddsValue = extractOdds(oddsData, topMarketKey, fixture.teams?.home?.id, fixture.teams?.away?.id);

  return {
    fixture_id: fixture.fixture?.id,
    kickoff: fixture.fixture?.date,
    league: fixture.leagueName,
    venue: fixture.fixture?.venue?.name || "",
    home: {
      id:   fixture.teams?.home?.id,
      name: homeName,
      logo: fixture.teams?.home?.logo || "",
    },
    away: {
      id:   fixture.teams?.away?.id,
      name: awayName,
      logo: fixture.teams?.away?.logo || "",
    },
    topMarket: {
      market: topMarketKey,
      score:  topScore,
      odds:   oddsValue,
      ...getTier(topScore),
    },
    allMarkets,
    keyStats: {
      homeGoalsPerGame:   round2(home.goalsPerGame),
      awayGoalsPerGame:   round2(away.goalsPerGame),
      homeConcededPerGame: round2(home.concededPerGame),
      awayConcededPerGame: round2(away.concededPerGame),
      homeBTTSRate:       pct(home.bttsRate),
      awayBTTSRate:       pct(away.bttsRate),
      h2hBTTSRate:        pct(h2hStats.bttsRate),
      h2hAvgGoals:        round2(h2hStats.avgGoals),
      h2hHomeWinRate:     pct(h2hStats.homeWinRate),
      h2hAwayWinRate:     pct(h2hStats.awayWinRate),
      h2hDrawRate:        pct(h2hStats.drawRate),
      h2hGames:           h2hStats.total,
    },
  };
}

// ── Stat derivation ───────────────────────────────────────────────────────────

function deriveStats(stats, venue) {
  if (!stats) return emptyStats();

  const goals = stats.goals || {};
  const fixtures = stats.fixtures || {};

  const played = (venue === "home")
    ? (fixtures.played?.home || 0)
    : (fixtures.played?.away || 0);

  const scored = (venue === "home")
    ? (goals.for?.total?.home || 0)
    : (goals.for?.total?.away || 0);

  const conceded = (venue === "home")
    ? (goals.against?.total?.home || 0)
    : (goals.against?.total?.away || 0);

  // BTTS: games where both teams scored
  // API gives us clean sheets — infer BTTS = played - clean_sheets (home) - games_failed_to_score
  const cleanSheets = (venue === "home")
    ? (stats.clean_sheet?.home || 0)
    : (stats.clean_sheet?.away || 0);

  const failedToScore = (venue === "home")
    ? (stats.failed_to_score?.home || 0)
    : (stats.failed_to_score?.away || 0);

  // BTTS happened when: opponent scored (non-clean-sheet) AND we scored (non-failed)
  const opponentScored = played - cleanSheets;
  const weScoredGames = played - failedToScore;
  const bttsCount = Math.min(opponentScored, weScoredGames); // approximation
  const bttsRate = played > 0 ? bttsCount / played : 0.5;

  const goalsPerGame   = played > 0 ? scored / played : 1.2;
  const concededPerGame = played > 0 ? conceded / played : 1.2;

  // Win/draw/loss rates
  const wins   = (venue === "home") ? (fixtures.wins?.home || 0) : (fixtures.wins?.away || 0);
  const draws  = (venue === "home") ? (fixtures.draws?.home || 0) : (fixtures.draws?.away || 0);
  const losses = (venue === "home") ? (fixtures.loses?.home || 0) : (fixtures.loses?.away || 0);

  const winRate  = played > 0 ? wins  / played : 0.33;
  const drawRate = played > 0 ? draws / played : 0.25;
  const lossRate = played > 0 ? losses / played : 0.33;

  return { played, goalsPerGame, concededPerGame, bttsRate, winRate, drawRate, lossRate };
}

function emptyStats() {
  return { played: 0, goalsPerGame: 1.2, concededPerGame: 1.2, bttsRate: 0.5, winRate: 0.33, drawRate: 0.25, lossRate: 0.33 };
}

function deriveH2H(h2h, homeTeamId) {
  if (!h2h || h2h.length === 0) {
    return { total: 0, avgGoals: 2.5, bttsRate: 0.5, homeWinRate: 0.33, awayWinRate: 0.33, drawRate: 0.25 };
  }

  const recent = h2h.slice(0, 10);
  let goals = 0, btts = 0, homeWins = 0, awayWins = 0, draws = 0;

  recent.forEach((match) => {
    const hg = match.goals?.home || 0;
    const ag = match.goals?.away || 0;
    goals += hg + ag;
    if (hg > 0 && ag > 0) btts++;
    const isHome = match.teams?.home?.id === homeTeamId;
    if (hg > ag) { if (isHome) homeWins++; else awayWins++; }
    else if (ag > hg) { if (isHome) awayWins++; else homeWins++; }
    else draws++;
  });

  const n = recent.length;
  return {
    total: n,
    avgGoals:    goals / n,
    bttsRate:    btts / n,
    homeWinRate: homeWins / n,
    awayWinRate: awayWins / n,
    drawRate:    draws / n,
  };
}

// ── Market scorers ────────────────────────────────────────────────────────────
// Each returns 0–100. Threshold for display: 55.

function scoreBTTS(home, away, h2h) {
  // High if both teams score often and concede often
  const homeAttack  = clamp(home.goalsPerGame  / 2.0 * 100, 0, 100);
  const awayAttack  = clamp(away.goalsPerGame  / 2.0 * 100, 0, 100);
  const homeDef     = clamp(home.concededPerGame / 2.0 * 100, 0, 100); // higher conceded = better for BTTS
  const awayDef     = clamp(away.concededPerGame / 2.0 * 100, 0, 100);
  const homeBTTS    = home.bttsRate * 100;
  const awayBTTS    = away.bttsRate * 100;
  const h2hBTTS     = h2h.bttsRate  * 100;

  return Math.round(
    homeAttack * 0.15 +
    awayAttack * 0.15 +
    homeDef    * 0.10 +
    awayDef    * 0.10 +
    homeBTTS   * 0.20 +
    awayBTTS   * 0.20 +
    h2hBTTS    * 0.10
  );
}

function scoreOver25(home, away, h2h) {
  // Over 2.5: avg goals in fixture needs to be high
  const expectedGoals = home.goalsPerGame + away.goalsPerGame;
  const xgScore       = clamp((expectedGoals - 1.0) / 3.0 * 100, 0, 100);
  const h2hGoalScore  = clamp((h2h.avgGoals - 1.0) / 4.0 * 100, 0, 100);
  const homeBTTS      = home.bttsRate * 100;
  const awayBTTS      = away.bttsRate * 100;

  return Math.round(
    xgScore    * 0.35 +
    h2hGoalScore * 0.30 +
    homeBTTS   * 0.175 +
    awayBTTS   * 0.175
  );
}

function scoreHomeWin(home, away, h2h) {
  const homeFormScore  = home.winRate * 100;
  const awayLossScore  = away.lossRate * 100;
  const h2hHomeWin     = h2h.homeWinRate * 100;
  // Advantage factor: home scores more than away concedes — or vice versa
  const attackDef = clamp((home.goalsPerGame - away.concededPerGame + 2) / 4 * 100, 0, 100);

  return Math.round(
    homeFormScore * 0.30 +
    awayLossScore * 0.20 +
    h2hHomeWin    * 0.25 +
    attackDef     * 0.25
  );
}

function scoreAwayWin(home, away, h2h) {
  const awayFormScore  = away.winRate * 100;
  const homeLossScore  = home.lossRate * 100;
  const h2hAwayWin     = h2h.awayWinRate * 100;
  const attackDef = clamp((away.goalsPerGame - home.concededPerGame + 2) / 4 * 100, 0, 100);

  return Math.round(
    awayFormScore * 0.30 +
    homeLossScore * 0.20 +
    h2hAwayWin    * 0.25 +
    attackDef     * 0.25
  );
}

function scoreDraw(home, away, h2h) {
  const homeDrawRate  = home.drawRate * 100;
  const awayDrawRate  = away.drawRate * 100;
  const h2hDrawRate   = h2h.drawRate  * 100;
  // When neither team has a big scoring edge → draw likely
  const evenness = 100 - clamp(Math.abs(home.goalsPerGame - away.goalsPerGame) / 2.0 * 100, 0, 100);

  return Math.round(
    homeDrawRate * 0.25 +
    awayDrawRate * 0.25 +
    h2hDrawRate  * 0.25 +
    evenness     * 0.25
  );
}

// ── Odds extraction ───────────────────────────────────────────────────────────

function extractOdds(oddsData, market, homeId, awayId) {
  if (!oddsData) return null;
  const bets = oddsData.bookmakers?.[0]?.bets || [];

  const marketMap = {
    HOME_WIN: { betName: "Match Winner", valueFn: (v) => v.find((x) => x.value === "Home")?.odd },
    AWAY_WIN: { betName: "Match Winner", valueFn: (v) => v.find((x) => x.value === "Away")?.odd },
    DRAW:     { betName: "Match Winner", valueFn: (v) => v.find((x) => x.value === "Draw")?.odd },
    BTTS:     { betName: "Both Teams To Score", valueFn: (v) => v.find((x) => x.value === "Yes")?.odd },
    OVER25:   { betName: "Goals Over/Under", valueFn: (v) => v.find((x) => x.value === "Over 2.5")?.odd },
  };

  const config = marketMap[market];
  if (!config) return null;

  const bet = bets.find((b) => b.name === config.betName);
  if (!bet) return null;

  return parseFloat(config.valueFn(bet.values || [])) || null;
}

// ── Tier classification ───────────────────────────────────────────────────────

function getTier(score) {
  if (score >= 80) return { tier: "BANKER",     label: "⭐ Banker",     description: "High confidence — lead pick of the day." };
  if (score >= 68) return { tier: "VALUE PLAY", label: "💡 Value Play", description: "Good value — ideal for accumulators." };
  return               { tier: "LONGSHOT",   label: "🎯 Longshot",   description: "Speculative — keep stakes small." };
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function todayStr() {
  return new Date().toISOString().split("T")[0];
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function round2(n) {
  return Math.round((n || 0) * 100) / 100;
}

function pct(n) {
  return Math.round((n || 0) * 100);
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

function jsonResponse(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
    body: JSON.stringify(body),
  };
}
