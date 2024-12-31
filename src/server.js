const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const passport = require('./config/auth');
const { pool, initDatabase, testConnection } = require('./config/database');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const OpenAI = require('openai');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5001;

// Security middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'", 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com'],
            scriptSrcAttr: ["'unsafe-inline'", "'unsafe-hashes'"],
            styleSrc: ["'self'", "'unsafe-inline'", 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com'],
            imgSrc: ["'self'", 'cdn.discordapp.com', 'data:', 'https:'],
            connectSrc: ["'self'", 'https://api.exchangerate-api.com'],
            fontSrc: ["'self'", 'cdnjs.cloudflare.com'],
            objectSrc: ["'none'"],
            mediaSrc: ["'none'"],
            frameSrc: ["'none'"]
        },
    },
    crossOriginEmbedderPolicy: false,
}));

app.use(cors({
    origin: process.env.NODE_ENV === 'production' ? process.env.CORS_ORIGIN : 'http://localhost:5001',
    credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Session configuration
const sessionConfig = {
    store: new pgSession({
        pool,
        tableName: 'session',
        createTableIfMissing: false,
        pruneSessionInterval: 60 * 15
    }),
    name: 'sid',
    secret: process.env.SESSION_SECRET || 'your-secret-key-change-this',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
        httpOnly: true
    }
};

if (app.get('env') === 'production') {
    app.set('trust proxy', 1); // trust first proxy
    sessionConfig.cookie.secure = true; // serve secure cookies
}

app.use(session(sessionConfig));

// Initialize Passport
app.use(passport.initialize());
app.use(passport.session());

// Authentication middleware
const isAuthenticated = (req, res, next) => {
    if (req.isAuthenticated()) {
        return next();
    }
    res.redirect('/login.html');
};

// API Authentication middleware
const isApiAuthenticated = async (req, res, next) => {
    const apiKey = req.headers.authorization?.split(' ')[1];
    if (!apiKey) {
        return res.status(401).json({ error: 'API key required' });
    }

    try {
        const result = await pool.query(
            'SELECT user_id FROM api_keys WHERE key_value = $1 AND is_active = true',
            [apiKey]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid API key' });
        }

        // Update last_used timestamp
        await pool.query(
            'UPDATE api_keys SET last_used = CURRENT_TIMESTAMP WHERE key_value = $1',
            [apiKey]
        );

        req.user = { id: result.rows[0].user_id };
        next();
    } catch (err) {
        console.error('API authentication error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// Serve static files
app.get('/', (req, res) => {
    res.redirect('/login.html');
});

app.get('/budgets.html', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'budgets.html'));
});

app.get('/login.html', (req, res) => {
    if (req.isAuthenticated()) {
        res.redirect('/dashboard.html');
    } else {
        res.sendFile(path.join(__dirname, 'views', 'login.html'));
    }
});

// Auth routes
app.get('/auth/discord', passport.authenticate('discord'));

app.get('/auth/discord/callback',
    passport.authenticate('discord', {
        failureRedirect: '/login.html'
    }),
    (req, res) => {
        res.redirect('/dashboard.html');
    }
);

app.get('/auth/logout', (req, res) => {
    req.logout(() => {
        res.redirect('/login.html');
    });
});

// Protected routes
app.get('/dashboard.html', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

app.get('/settings.html', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'settings.html'));
});

app.get('/api-keys.html', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'api-keys.html'));
});

// API Routes
app.get('/api/user', isAuthenticated, (req, res) => {
    res.json(req.user);
});

// Transactions API
app.get('/api/transactions', isAuthenticated, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT t.*, c.name as category_name FROM transactions t LEFT JOIN categories c ON t.category_id = c.id WHERE t.user_id = $1 ORDER BY t.date DESC',
            [req.user.id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching transactions:', err);
        res.status(500).json({ error: 'Failed to fetch transactions' });
    }
});

app.post('/api/transactions', isAuthenticated, async (req, res) => {
    const { amount, description, category_id, type, date } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO transactions (user_id, amount, description, category_id, type, date) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [req.user.id, amount, description, category_id, type, date || new Date()]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error creating transaction:', err);
        res.status(500).json({ error: 'Failed to create transaction' });
    }
});

app.delete('/api/transactions/:id', isAuthenticated, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // First check if transaction exists and belongs to user
        const checkResult = await client.query(
            'SELECT id FROM transactions WHERE id = $1 AND user_id = $2',
            [req.params.id, req.user.id]
        );

        if (checkResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Transaction not found' });
        }

        // Delete the transaction
        await client.query(
            'DELETE FROM transactions WHERE id = $1',
            [req.params.id]
        );

        await client.query('COMMIT');
        res.json({ message: 'Transaction deleted successfully' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error deleting transaction:', err);
        res.status(500).json({ error: 'Failed to delete transaction' });
    } finally {
        client.release();
    }
});

// Categories API
app.get('/api/categories', isAuthenticated, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM categories 
             WHERE user_id IS NULL OR user_id = $1 
             ORDER BY is_system DESC, name ASC`,
            [req.user.id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching categories:', err);
        res.status(500).json({ error: 'Failed to fetch categories' });
    }
});

// Settings API
app.get('/api/settings', isAuthenticated, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM user_settings WHERE user_id = $1',
            [req.user.id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error fetching settings:', err);
        res.status(500).json({ error: 'Failed to fetch settings' });
    }
});

app.put('/api/settings', isAuthenticated, async (req, res) => {
    const { currency } = req.body;
    try {
        const result = await pool.query(
            'UPDATE user_settings SET currency = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2 RETURNING *',
            [currency, req.user.id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error updating settings:', err);
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

// API Keys
app.get('/api/keys', isAuthenticated, async (req, res) => {
    const client = await pool.connect();
    try {
        const result = await client.query(
            'SELECT id, name, key_value, created_at, last_used, is_active FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC',
            [req.user.id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching API keys:', err);
        res.status(500).json({ error: 'Failed to fetch API keys' });
    } finally {
        client.release();
    }
});

app.post('/api/keys', isAuthenticated, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Validate input
        const { name } = req.body;
        if (!name || typeof name !== 'string' || name.trim().length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Valid key name is required' });
        }

        // Verify user exists
        const userCheck = await client.query(
            'SELECT id FROM users WHERE id = $1',
            [req.user.id]
        );
        if (userCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'User not found' });
        }

        // Generate a secure random key
        const keyValue = require('crypto').randomBytes(32).toString('hex'); // 64 characters

        // Insert the new API key
        const result = await client.query(
            'INSERT INTO api_keys (user_id, key_value, name, is_active) VALUES ($1, $2, $3, true) RETURNING id, name, key_value, created_at, is_active',
            [req.user.id, keyValue, name.trim()]
        );

        await client.query('COMMIT');
        res.json(result.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error creating API key:', err);
        if (err.code === '23505') { // unique_violation
            res.status(400).json({ error: 'An API key with this name already exists' });
        } else {
            res.status(500).json({ error: 'Failed to create API key' });
        }
    } finally {
        client.release();
    }
});

app.delete('/api/keys/:id', isAuthenticated, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Verify the API key exists and belongs to the user
        const keyCheck = await client.query(
            'SELECT id FROM api_keys WHERE id = $1 AND user_id = $2',
            [req.params.id, req.user.id]
        );

        if (keyCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'API key not found' });
        }

        // Delete the key
        await client.query(
            'DELETE FROM api_keys WHERE id = $1 AND user_id = $2',
            [req.params.id, req.user.id]
        );

        await client.query('COMMIT');
        res.json({ message: 'API key revoked successfully' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error revoking API key:', err);
        res.status(500).json({ error: 'Failed to revoke API key' });
    } finally {
        client.release();
    }
});

// Simple transaction API endpoint for external access
app.get('/api/v1/add-transaction', async (req, res) => {
    const apiKey = req.query.key;
    if (!apiKey) {
        return res.status(401).json({ error: 'API key required' });
    }

    try {
        // Validate API key and get user_id
        const keyResult = await pool.query(
            'SELECT ak.user_id FROM api_keys ak JOIN users u ON ak.user_id = u.id WHERE ak.key_value = $1 AND ak.is_active = true',
            [apiKey]
        );

        if (keyResult.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid API key or user not found' });
        }

        const userId = keyResult.rows[0].user_id;

        // Get parameters from query string
        const { amount, description, category_id, type } = req.query;

        // Validate required parameters
        if (!amount || !type || !description) {
            return res.status(400).json({ error: 'Missing required parameters' });
        }

        // Validate type
        if (!['income', 'expense'].includes(type)) {
            return res.status(400).json({ error: 'Invalid transaction type' });
        }

        // If category_id is provided, verify it exists and belongs to the user
        if (category_id) {
            const categoryResult = await pool.query(
                'SELECT id FROM categories WHERE (id = $1 AND (user_id IS NULL OR user_id = $2))',
                [category_id, userId]
            );
            if (categoryResult.rows.length === 0) {
                return res.status(400).json({ error: 'Invalid category' });
            }
        }

        // Insert transaction
        const result = await pool.query(
            'INSERT INTO transactions (user_id, amount, description, category_id, type, date) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP) RETURNING *',
            [userId, amount, description, category_id || null, type]
        );

        // Update API key last_used timestamp
        await pool.query(
            'UPDATE api_keys SET last_used = CURRENT_TIMESTAMP WHERE key_value = $1',
            [apiKey]
        );

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error adding transaction via API:', err);
        res.status(500).json({ error: 'Failed to add transaction' });
    }
});

// Import OpenAI at the top
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Add the new endpoint
app.get('/api/v1/parse-transaction', async (req, res) => {
    const apiKey = req.query.key;
    const notification = req.query.text;

    if (!apiKey || !notification) {
        return res.status(400).json({ error: 'API key and notification text are required' });
    }

    try {
        // Validate API key and get user_id
        const keyResult = await pool.query(
            'SELECT ak.user_id FROM api_keys ak JOIN users u ON ak.user_id = u.id WHERE ak.key_value = $1 AND ak.is_active = true',
            [apiKey]
        );

        if (keyResult.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid API key or user not found' });
        }

        const userId = keyResult.rows[0].user_id;

        // Get user's categories for context
        const categoriesResult = await pool.query(
            'SELECT id, name, type FROM categories WHERE user_id IS NULL OR user_id = $1',
            [userId]
        );
        const categories = categoriesResult.rows;

        const settingsResult = await pool.query(
            'SELECT currency FROM user_settings WHERE user_id = $1',
            [userId]
        );

        const userCurrency = settingsResult.rows[0]?.currency || 'USD';

        // Use GPT-4 to parse the notification
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: `You are a transaction parser. Extract transaction details from bank notifications.
                        Available categories: ${categories.map(c => `${c.name} (${c.type}, id: ${c.id})`).join(', ')}
                        User's preferred currency: ${userCurrency}. If the notification is in a different currency, convert it to ${userCurrency}.
                        Return a JSON object with:
                        - amount (number)
                        - type ("income" or "expense")
                        - description (string)
                        - category_id (number, matching one of the available categories)
                        If unsure about the category, use the most appropriate one.
                        If amount format is unclear, normalize it to a decimal number.`
                },
                {
                    role: "user",
                    content: notification
                }
            ],
            temperature: 0,
            response_format: { type: "json_object" }
        });

        const parsedData = JSON.parse(completion.choices[0].message.content);

        // Add the transaction
        const result = await pool.query(
            'INSERT INTO transactions (user_id, amount, description, category_id, type, date) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP) RETURNING *',
            [userId, parsedData.amount, parsedData.description, parsedData.category_id, parsedData.type]
        );

        // Update API key last_used timestamp
        await pool.query(
            'UPDATE api_keys SET last_used = CURRENT_TIMESTAMP WHERE key_value = $1',
            [apiKey]
        );

        res.json({
            message: 'Transaction added successfully',
            parsed_data: parsedData,
            transaction: result.rows[0]
        });
    } catch (err) {
        console.error('Error processing transaction:', err);
        res.status(500).json({ error: 'Failed to process transaction' });
    }
});

// Budget Management
app.get('/api/budgets', isAuthenticated, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Get all budgets and their current spending in a single query
        const result = await client.query(`
            WITH current_spending AS (
                SELECT 
                    category_id,
                    SUM(amount) as spent
                FROM transactions 
                WHERE user_id = $1 
                GROUP BY category_id
            )
            SELECT 
                b.*,
                c.name as category_name,
                c.type as category_type,
                COALESCE(cs.spent, 0) as current_spent
            FROM budgets b
            JOIN categories c ON b.category_id = c.id
            LEFT JOIN current_spending cs ON cs.category_id = b.category_id
            WHERE b.user_id = $1
            ORDER BY c.name`,
            [req.user.id]
        );

        await client.query('COMMIT');

        // Send the response immediately
        res.json(result.rows);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error fetching budgets:', err);
        res.status(500).json({ error: 'Failed to fetch budgets' });
    } finally {
        client.release();
    }
});

app.post('/api/budgets', isAuthenticated, async (req, res) => {
    const { category_id, amount, period, reset_day } = req.body;

    try {
        // Validate reset_day based on period
        if (period === 'monthly' && (reset_day < 1 || reset_day > 31)) {
            return res.status(400).json({ error: 'Monthly reset day must be between 1 and 31' });
        }
        if (period === 'weekly' && (reset_day < 0 || reset_day > 6)) {
            return res.status(400).json({ error: 'Weekly reset day must be between 0 (Sunday) and 6 (Saturday)' });
        }
        if (period === 'yearly' && (reset_day < 1 || reset_day > 366)) {
            return res.status(400).json({ error: 'Yearly reset day must be between 1 and 366' });
        }

        // Calculate initial last_reset based on period and reset_day
        let last_reset = new Date();
        if (period === 'monthly') {
            last_reset.setDate(reset_day);
            if (last_reset > new Date()) {
                last_reset.setMonth(last_reset.getMonth() - 1);
            }
        } else if (period === 'weekly') {
            const current_day = last_reset.getDay();
            const days_diff = reset_day - current_day;
            last_reset.setDate(last_reset.getDate() - (days_diff >= 0 ? 7 - days_diff : -days_diff));
        } else if (period === 'yearly') {
            last_reset = new Date(last_reset.getFullYear(), 0, reset_day);
            if (last_reset > new Date()) {
                last_reset.setFullYear(last_reset.getFullYear() - 1);
            }
        }

        const result = await pool.query(
            `INSERT INTO budgets (user_id, category_id, amount, period, reset_day, last_reset)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [req.user.id, category_id, amount, period, reset_day, last_reset]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error creating budget:', err);
        res.status(500).json({ error: 'Failed to create budget' });
    }
});

app.put('/api/budgets/:id', isAuthenticated, async (req, res) => {
    const { amount, period, reset_day } = req.body;
    try {
        const result = await pool.query(
            `UPDATE budgets 
             SET amount = $1, period = $2, reset_day = $3
             WHERE id = $4 AND user_id = $5
             RETURNING *`,
            [amount, period, reset_day, req.params.id, req.user.id]
        );
        if (result.rows.length === 0) {
            res.status(404).json({ error: 'Budget not found' });
        } else {
            res.json(result.rows[0]);
        }
    } catch (err) {
        console.error('Error updating budget:', err);
        res.status(500).json({ error: 'Failed to update budget' });
    }
});

app.delete('/api/budgets/:id', isAuthenticated, async (req, res) => {
    try {
        const result = await pool.query(
            'DELETE FROM budgets WHERE id = $1 AND user_id = $2 RETURNING *',
            [req.params.id, req.user.id]
        );
        if (result.rows.length === 0) {
            res.status(404).json({ error: 'Budget not found' });
        } else {
            res.json({ message: 'Budget deleted successfully' });
        }
    } catch (err) {
        console.error('Error deleting budget:', err);
        res.status(500).json({ error: 'Failed to delete budget' });
    }
});

// Budget Reset Job
async function resetBudgets() {
    const client = await pool.connect();
    try {
        // Get all budgets that need to be reset
        const now = new Date();
        const budgets = await client.query(
            'SELECT * FROM budgets WHERE last_reset IS NOT NULL'
        );

        for (const budget of budgets.rows) {
            let should_reset = false;
            const last_reset = new Date(budget.last_reset);

            if (budget.period === 'monthly') {
                // Check if we've passed the reset day in the current month
                const next_reset = new Date(last_reset);
                next_reset.setMonth(next_reset.getMonth() + 1);
                should_reset = now >= next_reset;
            } else if (budget.period === 'weekly') {
                // Check if we've passed 7 days and the specified day of week
                const days_since_reset = Math.floor((now - last_reset) / (1000 * 60 * 60 * 24));
                should_reset = days_since_reset >= 7 && now.getDay() === budget.reset_day;
            } else if (budget.period === 'yearly') {
                // Check if we've passed the reset day in the current year
                const next_reset = new Date(last_reset);
                next_reset.setFullYear(next_reset.getFullYear() + 1);
                should_reset = now >= next_reset;
            }

            if (should_reset) {
                // Calculate total spent for the period
                const spent = await client.query(
                    `SELECT COALESCE(SUM(amount), 0) as total
                     FROM transactions
                     WHERE category_id = $1 AND user_id = $2
                     AND date >= $3 AND date < $4`,
                    [budget.category_id, budget.user_id, budget.last_reset, now]
                );

                // Record budget history
                await client.query(
                    `INSERT INTO budget_history (budget_id, amount_spent, period_start, period_end)
                     VALUES ($1, $2, $3, $4)`,
                    [budget.id, spent.rows[0].total, budget.last_reset, now]
                );

                // Update last_reset
                await client.query(
                    'UPDATE budgets SET last_reset = $1 WHERE id = $2',
                    [now, budget.id]
                );
            }
        }
    } catch (err) {
        console.error('Error in budget reset job:', err);
    } finally {
        client.release();
    }
}

// Run budget reset job every hour
setInterval(resetBudgets, 60 * 60 * 1000);

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something broke!' });
});

// Initialize database and start server
const startServer = async () => {
    try {
        // Test database connection
        const isConnected = await testConnection();
        if (!isConnected) {
            throw new Error('Unable to connect to the database');
        }

        // Initialize database tables
        await initDatabase();

        // Add index for faster budget queries
        pool.query(`
            CREATE INDEX IF NOT EXISTS idx_transactions_user_date ON transactions(user_id, date);
            CREATE INDEX IF NOT EXISTS idx_budgets_user ON budgets(user_id);
        `).catch(err => console.error('Error creating indices:', err));

        // Start the server
        app.listen(PORT, () => {
            console.log(`Server is running on port ${PORT}`);
        });
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
};

startServer();
