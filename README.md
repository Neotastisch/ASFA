# ADFA: Actually Smart Finance App

A modern finance dashboard application with Discord OAuth2 integration. This application provides a secure and user-friendly interface for managing financial data with Discord authentication.

## Features

- Discord OAuth2 Authentication
- Secure Session Management
- PostgreSQL Database Integration
- RESTful API Architecture (eg. Linking with Tasker to automatically add transactions to the database)
- Modern Express.js Backend
- Helmet Security Integration
- CORS Support

## Prerequisites

- Node.js (v14 or higher)
- PostgreSQL Database
- Discord Developer Application (for OAuth2)
- OpenAI API Key (for AI features)

## Installation

1. Clone the repository

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file in the root directory with the following variables:
```env
PORT=3000
NODE_ENV=development

# Database Configuration
DB_USER=your_db_user
DB_PASSWORD=your_db_password
DB_HOST=localhost
DB_PORT=5432
DB_NAME=your_db_name

# Discord OAuth2
DISCORD_CLIENT_ID=your_discord_client_id
DISCORD_CLIENT_SECRET=your_discord_client_secret
DISCORD_CALLBACK_URL=http://localhost:3000/auth/discord/callback

# Session Secret
SESSION_SECRET=your_session_secret

# OpenAI
OPENAI_API_KEY=your_openai_api_key
```

4. Start the development server:
```bash
npm run dev
```

## Usage

The application will be available at `http://localhost:3000` (or your configured port).

1. Visit the homepage
2. Click "Login with Discord" to authenticate
3. Access your personalized finance dashboard

## API Endpoints

- `GET /auth/discord` - Discord authentication
- `GET /auth/discord/callback` - Discord OAuth2 callback
- `GET /api/user` - Get user information
- `POST /api/logout` - Logout user

## Security

This application implements several security measures:
- Helmet.js for HTTP headers security
- Session-based authentication
- CORS protection
- Environment variable configuration
- Secure password hashing with bcrypt

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details. 
