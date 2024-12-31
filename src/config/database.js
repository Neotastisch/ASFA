const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    // Add connection pool settings for stability
    max: 20, // Maximum number of clients in the pool
    idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
    connectionTimeoutMillis: 2000, // Return an error after 2 seconds if connection could not be established
    maxUses: 7500 // Close a connection after it has been used 7500 times
});

const initDatabase = async () => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Create users table with better constraints
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                discord_id VARCHAR(255) UNIQUE NOT NULL CHECK (discord_id <> ''),
                username VARCHAR(255) NOT NULL CHECK (username <> ''),
                avatar VARCHAR(255),
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT valid_discord_id CHECK (length(discord_id) >= 1)
            );
        `);

        // Create settings table with better defaults and constraints
        await client.query(`
            CREATE TABLE IF NOT EXISTS user_settings (
                user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                currency VARCHAR(10) NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT valid_currency CHECK (length(currency) = 3)
            );
        `);

        // Create categories table with better constraints
        await client.query(`
            CREATE TABLE IF NOT EXISTS categories (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                name VARCHAR(100) NOT NULL CHECK (name <> ''),
                type VARCHAR(20) NOT NULL CHECK (type IN ('income', 'expense')),
                color VARCHAR(7) NOT NULL CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_system BOOLEAN NOT NULL DEFAULT false,
                CONSTRAINT unique_category_per_user UNIQUE (user_id, name)
            );
        `);

        // Create transactions table with better constraints
        await client.query(`
            CREATE TABLE IF NOT EXISTS transactions (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
                amount DECIMAL(15,2) NOT NULL CHECK (amount >= 0),
                description TEXT NOT NULL DEFAULT '',
                date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                type VARCHAR(20) NOT NULL CHECK (type IN ('income', 'expense')),
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT valid_transaction CHECK (
                    (type = 'income' AND amount >= 0) OR
                    (type = 'expense' AND amount >= 0)
                )
            );
        `);

        // Create API keys table with better constraints
        await client.query(`
            CREATE TABLE IF NOT EXISTS api_keys (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                key_value VARCHAR(255) UNIQUE NOT NULL CHECK (length(key_value) >= 32),
                name VARCHAR(100) NOT NULL CHECK (name <> ''),
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                last_used TIMESTAMP,
                is_active BOOLEAN NOT NULL DEFAULT true,
                CONSTRAINT valid_key CHECK (length(key_value) >= 32)
            );
        `);

        // Create session table with better constraints
        await client.query(`
            CREATE TABLE IF NOT EXISTS "session" (
                sid varchar NOT NULL PRIMARY KEY CHECK (length(sid) >= 32),
                sess json NOT NULL,
                expire timestamp(6) NOT NULL,
                CONSTRAINT valid_session CHECK (expire > CURRENT_TIMESTAMP)
            );
            CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
        `);

        // Create budgets table with better constraints
        await client.query(`
            CREATE TABLE IF NOT EXISTS budgets (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
                amount DECIMAL(15,2) NOT NULL CHECK (amount > 0),
                period VARCHAR(20) NOT NULL CHECK (period IN ('monthly', 'weekly', 'yearly')),
                reset_day INTEGER NOT NULL,
                last_reset TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT valid_reset_day CHECK (
                    (period = 'monthly' AND reset_day BETWEEN 1 AND 31) OR
                    (period = 'weekly' AND reset_day BETWEEN 0 AND 6) OR
                    (period = 'yearly' AND reset_day BETWEEN 1 AND 366)
                ),
                CONSTRAINT unique_budget_per_category UNIQUE (user_id, category_id)
            );

            CREATE TABLE IF NOT EXISTS budget_history (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                budget_id INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
                amount_spent DECIMAL(15,2) NOT NULL CHECK (amount_spent >= 0),
                period_start TIMESTAMP NOT NULL,
                period_end TIMESTAMP NOT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT valid_period CHECK (period_end > period_start)
            );
        `);

        // Create indices for better query performance
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_transactions_user_date ON transactions(user_id, date);
            CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category_id);
            CREATE INDEX IF NOT EXISTS idx_categories_user ON categories(user_id);
            CREATE INDEX IF NOT EXISTS idx_budgets_user ON budgets(user_id);
            CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
            CREATE INDEX IF NOT EXISTS idx_budget_history_budget ON budget_history(budget_id);
        `);

        // Insert default categories with error handling
        await client.query(`
            INSERT INTO categories (name, type, color, is_system, user_id)
            SELECT name, type, color, is_system, CAST(user_id AS INTEGER)
            FROM (VALUES
                ('Salary', 'income', '#22c55e', true, NULL),
                ('Freelance', 'income', '#16a34a', true, NULL),
                ('Investments', 'income', '#15803d', true, NULL),
                ('Other Income', 'income', '#166534', true, NULL),
                ('Housing', 'expense', '#ef4444', true, NULL),
                ('Transportation', 'expense', '#dc2626', true, NULL),
                ('Food', 'expense', '#b91c1c', true, NULL),
                ('Utilities', 'expense', '#991b1b', true, NULL),
                ('Insurance', 'expense', '#7f1d1d', true, NULL),
                ('Healthcare', 'expense', '#f97316', true, NULL),
                ('Entertainment', 'expense', '#ea580c', true, NULL),
                ('Shopping', 'expense', '#c2410c', true, NULL),
                ('Other Expenses', 'expense', '#9a3412', true, NULL)
            ) AS v(name, type, color, is_system, user_id)
            WHERE NOT EXISTS (
                SELECT 1 FROM categories 
                WHERE is_system = true
            )
            ON CONFLICT DO NOTHING;
        `);

        await client.query('COMMIT');
        console.log('Database tables created successfully');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error initializing database:', err);
        throw err;
    } finally {
        client.release();
    }
};

// Improved connection handling
pool.on('error', (err) => {
    console.error('Unexpected error on idle client', err);
    process.exit(-1);
});

pool.on('connect', () => {
    console.log('Connected to PostgreSQL database');
});

// Enhanced connection test
const testConnection = async () => {
    let client;
    try {
        client = await pool.connect();
        await client.query('SELECT NOW()');
        console.log('Database connection test successful');
        return true;
    } catch (err) {
        console.error('Database connection test failed:', err);
        return false;
    } finally {
        if (client) client.release();
    }
};

// Add a function to check database health
const checkDatabaseHealth = async () => {
    let client;
    try {
        client = await pool.connect();
        
        // Check if all required tables exist
        const tables = ['users', 'user_settings', 'categories', 'transactions', 'api_keys', 'session', 'budgets', 'budget_history'];
        for (const table of tables) {
            const result = await client.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables 
                    WHERE table_schema = 'public' 
                    AND table_name = $1
                );
            `, [table]);
            
            if (!result.rows[0].exists) {
                throw new Error(`Missing required table: ${table}`);
            }
        }
        
        // Check if default categories exist
        const categoryCount = await client.query('SELECT COUNT(*) FROM categories WHERE is_system = true');
        if (categoryCount.rows[0].count === 0) {
            throw new Error('Missing default categories');
        }
        
        return true;
    } catch (err) {
        console.error('Database health check failed:', err);
        return false;
    } finally {
        if (client) client.release();
    }
};

module.exports = { 
    pool, 
    initDatabase, 
    testConnection,
    checkDatabaseHealth 
};
