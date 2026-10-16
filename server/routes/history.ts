/**
 * History Routes
 *
 * REST API endpoints for querying indexed event history and merged
 * cross-border timelines across federated deployments (ISP-144).
 */
import { Router, Request, Response } from 'express';
import type { ParsedEvent, CustodyMarker } from '../indexer/parser.js';

const router = Router();

// In-memory event store fallback / cache for fast access and federated testing
const eventHistoryStore: ParsedEvent[] = [];

export function recordHistoryEvent(event: ParsedEvent): void {
  eventHistoryStore.push(event);
  if (eventHistoryStore.length > 5000) {
    eventHistoryStore.shift();
  }
}

export function getHistoryEvents(): ParsedEvent[] {
  return [...eventHistoryStore];
}

export function clearHistoryEvents(): void {
  eventHistoryStore.length = 0;
}

/**
 * GET /api/history/events
 *
 * Query events with pagination, origin filtering, and custody demarcation.
 */
router.get('/events', async (req: Request, res: Response) => {
  try {
    const {
      type,
      origin_instance,
      custody_marker,
      include_foreign = 'true',
      page = '0',
      limit = '50',
    } = req.query;

    const pageNum = Math.max(0, parseInt(page as string, 10) || 0);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 50));
    const offset = pageNum * limitNum;

    let filtered = [...eventHistoryStore];

    if (include_foreign === 'false') {
      filtered = filtered.filter(
        (e) => !e.custodyMarker || e.custodyMarker === 'local_verified'
      );
    }

    if (type) {
      filtered = filtered.filter((e) => e.eventType === type);
    }

    if (origin_instance) {
      filtered = filtered.filter((e) => e.originInstance === origin_instance);
    }

    if (custody_marker) {
      filtered = filtered.filter((e) => e.custodyMarker === custody_marker);
    }

    filtered.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    const paged = filtered.slice(offset, offset + limitNum);

    res.json({
      events: paged,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: filtered.length,
        hasMore: offset + limitNum < filtered.length,
      },
    });
  } catch (error) {
    console.error('[History] Error querying events:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/history/events/:requestId
 *
 * Get all events for a specific emergency request across local and peer sources.
 */
router.get('/events/:requestId', async (req: Request, res: Response) => {
  try {
    const { requestId } = req.params;
    const events = eventHistoryStore.filter((e) => e.requestId === requestId);
    events.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    res.json({
      requestId,
      events,
    });
  } catch (error) {
    console.error('[History] Error querying request events:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/history/timeline/:requestId
 *
 * Merged cross-border timeline with explicit provenance demarcation.
 * Flagged for tamper evidence and peer custody tracking.
 */
router.get('/timeline/:requestId', async (req: Request, res: Response) => {
  try {
    const { requestId } = req.params;
    const events = eventHistoryStore.filter((e) => e.requestId === requestId);
    events.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    const timeline = events.map((ev) => {
      const isPeer = ev.custodyMarker === 'peer_asserted';
      const hasTamper = ev.federationVerified === false;
      return {
        timestamp: ev.timestamp,
        eventType: ev.eventType,
        actor: ev.responderAddress || ev.callerAddress,
        originInstance: ev.originInstance || 'local',
        custodyMarker: ev.custodyMarker || 'local_verified',
        provenanceLabel: isPeer
          ? `Asserted by peer instance (${ev.originInstance})`
          : 'Verified by local DAO',
        tamperDetected: hasTamper,
        verificationError: ev.federationError,
        details: ev.raw?.data || {},
      };
    });

    res.json({
      requestId,
      totalEvents: timeline.length,
      hasTamperAlert: timeline.some((t) => t.tamperDetected),
      timeline,
    });
  } catch (error) {
    console.error('[History] Error building timeline:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/history/stats
 *
 * Get aggregate statistics about indexed events including federation breakdown.
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const byType: Record<string, number> = {};
    const byCustody: Record<string, number> = {
      local_verified: 0,
      peer_asserted: 0,
      relayed: 0,
    };
    let tamperedCount = 0;

    for (const ev of eventHistoryStore) {
      byType[ev.eventType] = (byType[ev.eventType] || 0) + 1;
      const marker = ev.custodyMarker || 'local_verified';
      byCustody[marker] = (byCustody[marker] || 0) + 1;
      if (ev.federationVerified === false) {
        tamperedCount++;
      }
    }

    res.json({
      totalEvents: eventHistoryStore.length,
      byType,
      byCustody,
      tamperedCount,
      latestLedger: 0,
    });
  } catch (error) {
    console.error('[History] Error fetching stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
