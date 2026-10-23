require('dotenv').config();

const required = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 5000,
  mongoUri: required('MONGO_URI', 'mongodb://127.0.0.1:27017/betting_platform'),
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  jwt: {
    accessSecret: required('JWT_ACCESS_SECRET', 'dev-access-secret-change-me'),
    refreshSecret: required('JWT_REFRESH_SECRET', 'dev-refresh-secret-change-me'),
    accessTtl: process.env.JWT_ACCESS_TTL || '15m',
    refreshTtlDays: Number(process.env.JWT_REFRESH_TTL_DAYS) || 30,
  },
  bcryptSaltRounds: Number(process.env.BCRYPT_SALT_ROUNDS) || 12,
  /** Outgoing mail (password-reset codes). Leave SMTP_HOST empty to log mail to the console in development. */
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || process.env.SMTP_USER || 'no-reply@betting.local',
  },
  /** Diamond odds feed (cricket). Off when DIAMOND_API_KEY is empty. */
  diamond: {
    baseUrl: (process.env.DIAMOND_BASE_URL || 'http://46.202.166.33:3009').replace(/\/$/, ''),
    apiKey: process.env.DIAMOND_API_KEY || '',
    /** Embeddable players, `gmid` appended. */
    streamUrl: process.env.DIAMOND_STREAM_URL || 'https://live.cricketid.xyz/directStream?gmid=',
    scoreUrl: process.env.DIAMOND_SCORE_URL || 'https://score.akamaized.uk/diamond-live-score?gmid=',
    matchListMs: Number(process.env.DIAMOND_MATCH_LIST_MS) || 30000,
    liveOddsMs: Number(process.env.DIAMOND_LIVE_ODDS_MS) || 1000,
    upcomingOddsMs: Number(process.env.DIAMOND_UPCOMING_ODDS_MS) || 60000,
    resultsMs: Number(process.env.DIAMOND_RESULTS_MS) || 120000,
  },
  passwordReset: {
    codeTtlMinutes: Number(process.env.RESET_CODE_TTL_MINUTES) || 10,
    maxAttempts: 5,
    resendCooldownSeconds: 60,
    /** Testing shortcut: accepted as a reset code for any account. Never honoured in production. */
    masterCode: process.env.RESET_MASTER_CODE || '123456',
  },
};

if (env.nodeEnv === 'production') {
  if (env.jwt.accessSecret === 'dev-access-secret-change-me' || env.jwt.refreshSecret === 'dev-refresh-secret-change-me') {
    throw new Error('Refusing to start in production with default JWT secrets. Set JWT_ACCESS_SECRET / JWT_REFRESH_SECRET.');
  }
}

module.exports = env;
