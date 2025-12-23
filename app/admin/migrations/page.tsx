import { redirect } from 'next/navigation';
import { requireAdminAuth } from '../_lib/auth';
import { prisma } from '@/src/utils/prisma';

export default async function MigrationsPage() {
  // Require authentication
  try {
    await requireAdminAuth();
  } catch (error) {
    redirect('/admin');
  }

  // Fetch database schema information
  const tables = (await prisma.$queryRaw`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name;
  `) as Array<{ table_name: string }>;

  const userTable = (await prisma.$queryRaw`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'User'
    ORDER BY ordinal_position;
  `) as Array<{
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>;

  return (
    <html>
      <head>
        <title>Migrations</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>{`
          body {
            font-family: Arial, sans-serif;
            padding: 20px;
            background: #f5f5f5;
          }
          .box {
            background: white;
            padding: 30px;
            max-width: 1000px;
            margin: 0 auto 20px;
            border-radius: 10px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 15px;
          }
          th,
          td {
            padding: 10px;
            text-align: left;
            border-bottom: 1px solid #ddd;
          }
          th {
            background: #f9fafb;
            font-weight: bold;
          }
          a {
            color: #667eea;
            text-decoration: none;
            font-weight: bold;
          }
          a:hover {
            text-decoration: underline;
          }
        `}</style>
      </head>
      <body>
        <div className="box">
          <h2>📦 Database Schema</h2>
          <p>
            <strong>Tables:</strong> {tables.map((t) => t.table_name).join(', ')}
          </p>
        </div>

        <div className="box">
          <h2>User Table</h2>
          <table>
            <thead>
              <tr>
                <th>Column</th>
                <th>Type</th>
                <th>Nullable</th>
              </tr>
            </thead>
            <tbody>
              {userTable.map((column) => (
                <tr key={column.column_name}>
                  <td>{column.column_name}</td>
                  <td>{column.data_type}</td>
                  <td>{column.is_nullable === 'YES' ? '✓' : '✗'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="box">
          <p>
            <a href="/admin">← Back to Admin</a>
          </p>
        </div>
      </body>
    </html>
  );
}
