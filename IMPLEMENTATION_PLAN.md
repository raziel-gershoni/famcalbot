# Implementation Plan: Weekly Summary + Birthday Reminders

## Overview
Enhance the tomorrow-summary to include:
1. **Weekly preview** (tomorrow through Saturday) with filtered special events only
2. **Birthday reminders** with clustering logic (next birthday + all within 2 months from it)

## Components to Build

### 1. Configuration System (src/config/filters.ts - NEW)
Create flexible filter configuration for testing different approaches:
- Calendar ID blacklist/whitelist
- Keyword patterns for routine events
- Time-based filters (weekday school hours)
- Easy toggle between filter strategies

### 2. Calendar Service Extensions (src/services/calendar.ts)
Add two new functions:
- `fetchWeekEvents()`: Fetch tomorrow → Saturday in Asia/Jerusalem timezone
- `fetchUpcomingBirthdays()`:
  - Find absolute next birthday from birthday calendar
  - Calculate 2-month window from that date
  - Return all birthdays in that window
  - Sort chronologically

### 3. Event Filtering Utilities (src/utils/eventFilters.ts - NEW)
Build modular filter system:
- `filterByCalendarIds()`: Exclude/include specific calendars
- `filterByKeywords()`: Exclude events matching patterns (גן, dismissal, etc.)
- `filterByTimeSlot()`: Exclude weekday 8am-4pm events
- `applyFilters()`: Combine filters based on active strategy
- Make strategy configurable in config file

### 4. Update Tomorrow Summary Endpoint (api/tomorrow-summary.ts)
Modify to fetch and combine:
- Tomorrow's events (existing)
- Week events (new, filtered)
- Birthday events (new, with clustering)
- Pass all to enhanced Claude prompt

### 5. Claude Prompt Enhancement (src/services/claude.ts)
Extend `generateSummary()` to accept optional parameters:
- `weekEvents?: CalendarEvent[]`
- `birthdays?: CalendarEvent[]`

Add new prompt sections:
- "השבוע הקרוב" (Upcoming Week) - grouped by day, special events only
- "ימי הולדת" (Birthdays) - with countdown and clustering context

### 6. User Configuration (src/config/users.ts)
Add birthday calendar constant:
```typescript
const BIRTHDAY_CALENDAR_ID = '[user-provided-id]';
```

## Implementation Strategy

### Phase 1: Infrastructure
1. Create filter configuration system with multiple strategies
2. Build calendar fetching functions (week + birthdays)
3. Create filtering utilities
4. Add birthday calendar to config (user will provide ID)

### Phase 2: Integration
5. Modify tomorrow-summary to fetch weekly + birthday events
6. Update Claude prompt with new sections
7. Pass filtered events to Claude

### Phase 3: Testing & Tuning
8. Test with real data
9. Iterate on filter strategy based on results
10. Adjust Claude prompt formatting

## Filter Strategies to Implement

**Strategy A: Calendar-based**
- Exclude specific calendar IDs entirely

**Strategy B: Keyword-based**
- Pattern matching: גן, ביה"ס, dismissal, שחרור

**Strategy C: Time-based**
- Exclude Mon-Fri 08:00-16:00 events

**Strategy D: Hybrid**
- Combine multiple approaches

Config will allow easy switching between strategies for testing.

## Birthday Clustering Logic
```
1. Find next birthday globally (min date >= today)
2. Calculate window_end = next_birthday_date + 2 months
3. Return all birthdays where: next_birthday_date <= date <= window_end
4. Format with days-until countdown
```

## Key Design Decisions
- **Flexible filters:** Easy to test different approaches without code changes
- **Single message:** Weekly + birthdays included in tomorrow-summary (no separate endpoint)
- **Modular:** Each component independent for easier testing
- **Configurable:** Birthday calendar ID and filter strategy in config files
- **Claude-driven formatting:** Let Claude organize the presentation intelligently

## Requirements Gathered

### User Preferences:
- Weekly summary: Tomorrow through Saturday (Saturday = end of week)
- Filters: Need to experiment with different approaches (calendar IDs, keywords, time-based)
- Birthdays: Next birthday + all others within 2 months from that date
- Birthday calendar: User will provide the ID
- Delivery: Embedded in tomorrow-summary (sent daily in evening)

## What I Need From You
The birthday calendar ID to add to the configuration.
