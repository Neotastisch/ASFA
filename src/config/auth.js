const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const { pool } = require('./database');

passport.serializeUser((user, done) => {
    done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
    try {
        const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
        done(null, result.rows[0]);
    } catch (err) {
        done(err, null);
    }
});

passport.use(new DiscordStrategy({
    clientID: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    callbackURL: process.env.DISCORD_CALLBACK_URL,
    scope: ['identify']
}, async (accessToken, refreshToken, profile, done) => {
    try {
        // Check if user exists
        let result = await pool.query('SELECT * FROM users WHERE discord_id = $1', [profile.id]);

        if (result.rows.length === 0) {
            // Create new user
            result = await pool.query(
                'INSERT INTO users (discord_id, username, avatar) VALUES ($1, $2, $3) RETURNING *',
                [profile.id, profile.username, profile.avatar]
            );

            // Create default settings for new user
            await pool.query(
                'INSERT INTO user_settings (user_id) VALUES ($1)',
                [result.rows[0].id]
            );
        } else {
            // Update existing user
            result = await pool.query(
                'UPDATE users SET username = $1, avatar = $2 WHERE discord_id = $3 RETURNING *',
                [profile.username, profile.avatar, profile.id]
            );
        }

        done(null, result.rows[0]);
    } catch (err) {
        done(err, null);
    }
}));

module.exports = passport;
