'use client';

interface User {
  telegramId: bigint;
  name: string;
  hebrewName: string;
  location: string;
  whatsappPhone: string | null;
  messagingPlatform: string;
}

interface EditUserClientProps {
  user: User;
}

export default function EditUserClient({ user }: EditUserClientProps) {
  return (
    <html>
      <head>
        <title>Edit {user.name}</title>
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
            max-width: 600px;
            margin: 0 auto;
            border-radius: 10px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          label {
            display: block;
            margin-bottom: 5px;
            font-weight: bold;
            color: #333;
          }
          input,
          select {
            width: 100%;
            padding: 10px;
            margin: 5px 0 15px;
            border: 2px solid #ddd;
            border-radius: 5px;
            box-sizing: border-box;
            font-size: 16px;
          }
          .btn {
            padding: 12px 24px;
            background: #667eea;
            color: white;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            font-size: 16px;
          }
          .btn:hover {
            background: #5a67d8;
          }
          a {
            color: #667eea;
            text-decoration: none;
          }
        `}</style>
      </head>
      <body>
        <div className="box">
          <h2>Edit {user.name}</h2>
          <form method="POST" action="/api/admin/edit-user">
            <input type="hidden" name="id" value={user.telegramId.toString()} />

            <label htmlFor="name">Name</label>
            <input id="name" name="name" defaultValue={user.name} required />

            <label htmlFor="hebrewName">Hebrew Name</label>
            <input
              id="hebrewName"
              name="hebrewName"
              defaultValue={user.hebrewName}
              required
            />

            <label htmlFor="location">Location</label>
            <input id="location" name="location" defaultValue={user.location} required />

            <label htmlFor="whatsappPhone">WhatsApp</label>
            <input
              id="whatsappPhone"
              name="whatsappPhone"
              defaultValue={user.whatsappPhone || ''}
              placeholder="+972..."
            />

            <label htmlFor="messagingPlatform">Platform</label>
            <select id="messagingPlatform" name="messagingPlatform">
              <option
                value="telegram"
                selected={user.messagingPlatform === 'telegram'}
              >
                Telegram
              </option>
              <option
                value="whatsapp"
                selected={user.messagingPlatform === 'whatsapp'}
              >
                WhatsApp
              </option>
              <option value="all" selected={user.messagingPlatform === 'all'}>
                Both
              </option>
            </select>

            <button type="submit" className="btn">
              Save
            </button>
            <div style={{ marginTop: '20px' }}>
              <a href="/admin">← Back to Admin</a>
            </div>
          </form>
        </div>
      </body>
    </html>
  );
}
