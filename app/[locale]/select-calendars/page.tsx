import { notFound } from 'next/navigation';
import { getUserByTelegramId } from '@/src/services/user-service';
import { listUserCalendars } from '@/src/services/calendar';
import { CalendarAssignment, CalendarLabel } from '@/src/types';
import SelectCalendarsClient from './SelectCalendarsClient';

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ user_id?: string }>;
}

// Convert calendarAssignments to state format
function convertAssignmentsToSelections(assignments: CalendarAssignment[]): {
  selectedCalendars: Set<string>;
  calendarLabels: Map<string, Set<CalendarLabel>>;
} {
  const selectedCalendars = new Set<string>();
  const calendarLabels = new Map<string, Set<CalendarLabel>>();

  for (const assignment of assignments) {
    selectedCalendars.add(assignment.calendarId);
    calendarLabels.set(assignment.calendarId, new Set(assignment.labels));
  }

  return { selectedCalendars, calendarLabels };
}

// Convert legacy fields to state format
function convertLegacyToSelections(
  primaryCalendar: string,
  ownCalendars: string[],
  spouseCalendars: string[]
): {
  selectedCalendars: Set<string>;
  calendarLabels: Map<string, Set<CalendarLabel>>;
} {
  const selectedCalendars = new Set<string>();
  const calendarLabels = new Map<string, Set<CalendarLabel>>();

  // Add primary calendar (must be in 'yours' too)
  if (primaryCalendar) {
    selectedCalendars.add(primaryCalendar);
    calendarLabels.set(primaryCalendar, new Set<CalendarLabel>(['primary', 'yours']));
  }

  // Add own calendars (skip if already added as primary)
  for (const calId of ownCalendars) {
    selectedCalendars.add(calId);
    if (!calendarLabels.has(calId)) {
      calendarLabels.set(calId, new Set<CalendarLabel>(['yours']));
    }
  }

  // Add spouse calendars
  for (const calId of spouseCalendars) {
    selectedCalendars.add(calId);
    calendarLabels.set(calId, new Set<CalendarLabel>(['spouse']));
  }

  return { selectedCalendars, calendarLabels };
}

export default async function SelectCalendarsPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  const searchParamsData = await searchParams;
  const userId = searchParamsData.user_id ? parseInt(searchParamsData.user_id) : null;

  if (!userId) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        padding: '20px'
      }}>
        <div style={{
          background: 'white',
          padding: '40px',
          borderRadius: '15px',
          boxShadow: '0 10px 40px rgba(0,0,0,0.2)',
          textAlign: 'center',
          maxWidth: '400px'
        }}>
          <div style={{ fontSize: '64px', marginBottom: '20px' }}>⚠️</div>
          <h1 style={{ color: '#ef4444', margin: '0 0 10px 0' }}>Missing Parameter</h1>
          <p style={{ color: '#666' }}>user_id parameter is required</p>
        </div>
      </div>
    );
  }

  const user = await getUserByTelegramId(userId);

  if (!user) {
    notFound();
  }

  // Check if URL locale matches user's language preference
  const userLocale = user.language === 'Hebrew' ? 'he' : 'en';
  if (locale !== userLocale) {
    const { redirect } = await import('next/navigation');
    redirect(`/${userLocale}/select-calendars?user_id=${userId}`);
  }

  if (!user.googleRefreshToken) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        padding: '20px'
      }}>
        <div style={{
          background: 'white',
          padding: '40px',
          borderRadius: '15px',
          boxShadow: '0 10px 40px rgba(0,0,0,0.2)',
          textAlign: 'center',
          maxWidth: '400px'
        }}>
          <div style={{ fontSize: '64px', marginBottom: '20px' }}>⚠️</div>
          <h1 style={{ color: '#ef4444', margin: '0 0 10px 0' }}>No Google Token</h1>
          <p style={{ color: '#666' }}>Please refresh your token first.</p>
        </div>
      </div>
    );
  }

  try {
    const availableCalendars = await listUserCalendars(user.googleRefreshToken);

    // Convert user's current selections to new state format
    let currentSelections;

    if (user.calendarAssignments && user.calendarAssignments.length > 0) {
      // New format: use calendarAssignments
      currentSelections = convertAssignmentsToSelections(user.calendarAssignments);
    } else {
      // Legacy format: convert from old fields
      currentSelections = convertLegacyToSelections(
        user.primaryCalendar || '',
        user.ownCalendars || [],
        user.spouseCalendars || []
      );
    }

    return (
      <SelectCalendarsClient
        userId={userId}
        userName={user.name}
        availableCalendars={availableCalendars}
        currentSelections={currentSelections}
      />
    );
  } catch (error) {
    console.error('Error listing calendars:', error);
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        padding: '20px'
      }}>
        <div style={{
          background: 'white',
          padding: '40px',
          borderRadius: '15px',
          boxShadow: '0 10px 40px rgba(0,0,0,0.2)',
          textAlign: 'center',
          maxWidth: '400px'
        }}>
          <div style={{ fontSize: '64px', marginBottom: '20px' }}>❌</div>
          <h1 style={{ color: '#ef4444', margin: '0 0 10px 0' }}>Error</h1>
          <p style={{ color: '#666' }}>
            {error instanceof Error ? error.message : 'Unknown error'}
          </p>
          <a href={`/select-calendars?user_id=${userId}`} style={{ color: '#667eea' }}>
            Try Again
          </a>
        </div>
      </div>
    );
  }
}
