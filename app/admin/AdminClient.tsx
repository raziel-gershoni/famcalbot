'use client';

import { Settings2, Users, RefreshCw, PencilLine, Wrench, Database } from 'lucide-react';

interface User {
  telegramId: number;
  name: string;
  hebrewName: string;
  whatsappPhone?: string | null;
  messagingPlatform: string;
  location: string;
}

interface AdminClientProps {
  users: User[];
}

export default function AdminClient({ users }: AdminClientProps) {
  const getOAuthUrl = (telegramId: number) => {
    const baseUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
    const params = new URLSearchParams({
      client_id: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || '',
      redirect_uri: `${window.location.origin}/api/admin/oauth-refresh`,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/calendar.readonly',
      access_type: 'offline',
      prompt: 'consent',
      state: telegramId.toString()
    });
    return `${baseUrl}?${params.toString()}`;
  };

  return (
    <html>
      <head>
        <title>Admin Dashboard</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>{`
          * {
            box-sizing: border-box;
          }
          body {
            font-family: Arial, sans-serif;
            background: #f5f5f5;
            margin: 0;
            padding: 20px;
          }
          .container {
            max-width: 1200px;
            margin: 0 auto;
          }
          header {
            background: white;
            padding: 20px;
            border-radius: 10px;
            margin-bottom: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          h1 {
            margin: 0;
            color: #333;
          }
          .section {
            background: white;
            padding: 20px;
            border-radius: 10px;
            margin-bottom: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          .user-card {
            border: 1px solid #ddd;
            padding: 15px;
            border-radius: 5px;
            margin-bottom: 10px;
          }
          .user-card h3 {
            margin: 0 0 10px 0;
          }
          .user-info {
            display: grid;
            grid-template-columns: 150px 1fr;
            gap: 10px;
            margin-bottom: 15px;
          }
          .user-info label {
            font-weight: bold;
            color: #666;
          }
          .btn {
            display: inline-block;
            padding: 10px 20px;
            background: #667eea;
            color: white;
            text-decoration: none;
            border-radius: 5px;
            margin-right: 10px;
            font-size: 14px;
            border: none;
            cursor: pointer;
          }
          .btn:hover {
            background: #5a67d8;
          }
          .btn-success {
            background: #22c55e;
          }
          .btn-success:hover {
            background: #16a34a;
          }
          .logout {
            float: right;
            background: #ef4444;
          }
          .logout:hover {
            background: #dc2626;
          }
        `}</style>
      </head>
      <body>
        <div className="container">
          <header>
            <h1><Settings2 size={20} style={{ verticalAlign: 'middle', marginRight: '4px' }} /> FamCalBot Admin</h1>
            <a href="/api/admin/logout" className="btn logout">
              Logout
            </a>
          </header>

          <div className="section">
            <h2><Users size={20} style={{ verticalAlign: 'middle', marginRight: '4px' }} /> User Management</h2>
            {users.map((user) => (
              <div key={user.telegramId.toString()} className="user-card">
                <h3>{user.name} ({user.hebrewName})</h3>
                <div className="user-info">
                  <label>Telegram ID:</label>
                  <span>{user.telegramId.toString()}</span>

                  <label>WhatsApp:</label>
                  <span>{user.whatsappPhone || 'Not set'}</span>

                  <label>Platform:</label>
                  <span>{user.messagingPlatform}</span>

                  <label>Location:</label>
                  <span>{user.location}</span>
                </div>
                <a
                  href={getOAuthUrl(user.telegramId)}
                  className="btn btn-success"
                >
                  <RefreshCw size={16} style={{ verticalAlign: 'middle', marginRight: '4px' }} /> Refresh Google Token
                </a>
                <a
                  href={`/admin/edit-user?id=${user.telegramId.toString()}`}
                  className="btn"
                >
                  <PencilLine size={16} style={{ verticalAlign: 'middle', marginRight: '4px' }} /> Edit User
                </a>
              </div>
            ))}
          </div>

          <div className="section">
            <h2><Wrench size={20} style={{ verticalAlign: 'middle', marginRight: '4px' }} /> System Tools</h2>
            <a href="/admin/migrations" className="btn">
              <Database size={16} style={{ verticalAlign: 'middle', marginRight: '4px' }} /> View Database Schema
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
