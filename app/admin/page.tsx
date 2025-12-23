import { isAdminAuthenticated } from './_lib/auth';
import { getAllUsers } from '@/src/services/user-service';
import AdminClient from './AdminClient';

// Login Page Component
function LoginPage() {
  return (
    <html>
      <head>
        <title>Admin Login</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>{`
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0;
          }
          .login-box {
            background: white;
            padding: 40px;
            border-radius: 10px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            max-width: 400px;
            width: 100%;
          }
          h2 {
            margin-top: 0;
            color: #333;
          }
          input[type="password"] {
            width: 100%;
            padding: 12px;
            border: 2px solid #ddd;
            border-radius: 5px;
            font-size: 16px;
            box-sizing: border-box;
          }
          button {
            width: 100%;
            padding: 12px;
            background: #667eea;
            color: white;
            border: none;
            border-radius: 5px;
            font-size: 16px;
            cursor: pointer;
            margin-top: 10px;
          }
          button:hover {
            background: #5a67d8;
          }
        `}</style>
      </head>
      <body>
        <div className="login-box">
          <h2>🔐 Admin Login</h2>
          <form method="POST" action="/api/admin">
            <input
              type="password"
              name="password"
              placeholder="Enter admin password"
              required
              autoFocus
            />
            <button type="submit">Login</button>
          </form>
        </div>
      </body>
    </html>
  );
}

export default async function AdminPage() {
  // Check authentication
  const isAuthenticated = await isAdminAuthenticated();

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  // Fetch data for authenticated admin
  const users = await getAllUsers();

  return <AdminClient users={users} />;
}
