// Load user information
async function loadUserInfo() {
    try {
        const response = await fetch('/api/user', {
            credentials: 'include'
        });
        const user = await response.json();

        // Update navigation bar with user info
        const userInfoElement = document.getElementById('user-info');
        if (userInfoElement) {
            userInfoElement.innerHTML = `
                <img src="https://cdn.discordapp.com/avatars/${user.discord_id}/${user.avatar}.png" alt="Profile" class="profile-pic">
                <span class="username">${user.username}</span>
            `;
        }
    } catch (err) {
        console.error('Failed to load user info:', err);
    }
}

// Create and append navigation sidebar
function createSidebar() {
    const sidebar = document.createElement('nav');
    sidebar.className = 'sidebar';
    sidebar.innerHTML = `
        <div class="sidebar-header">
            <h2>Finance Tracker</h2>
        </div>
        <div id="user-info" class="user-info"></div>
        <ul class="nav-links">
            <li><a href="/dashboard.html" class="nav-link">
                <i class="fas fa-chart-line"></i>Dashboard
            </a></li>
            <li><a href="/api-keys.html" class="nav-link">
                <i class="fas fa-key"></i>API Keys
            </a></li>
            <li><a href="/budgets.html" class="nav-link">
                <i class="fas fa-wallet"></i>Budgets
            </a></li>
            <li><a href="/settings.html" class="nav-link">
                <i class="fas fa-cog"></i>Settings
            </a></li>

            <li><a href="/auth/logout" class="nav-link">
                <i class="fas fa-sign-out-alt"></i>Logout
            </a></li>
        </ul>
    `;
    document.body.insertBefore(sidebar, document.body.firstChild);
}

// Add at the top with other globals
let currencyFormatter = null;

// Replace the formatCurrency function
async function formatCurrency(amount) {
    if (!currencyFormatter) {
        try {
            const response = await fetch('/api/settings', {
                credentials: 'include'
            });
            const settings = await response.json();
            currencyFormatter = new Intl.NumberFormat('en-US', {
                style: 'currency',
                currency: settings.currency || 'USD'
            });
        } catch (err) {
            console.error('Failed to load settings:', err);
            currencyFormatter = new Intl.NumberFormat('en-US', {
                style: 'currency',
                currency: 'USD'
            });
        }
    }
    return currencyFormatter.format(amount);
}

// Initialize sidebar and user info when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    createSidebar();
    loadUserInfo();

    // Highlight current page in navigation
    const currentPage = window.location.pathname;
    const navLinks = document.querySelectorAll('.nav-link');
    navLinks.forEach(link => {
        if (link.getAttribute('href') === currentPage) {
            link.classList.add('active');
        }
    });
});
