import { Router, Request, Response } from 'express';
import prisma from '../utils/prisma';
import { FlowWithAccounts } from '../types/db';
import { HTTP_STATUS, ERROR_MESSAGES } from '../constants';
import { runAutomationFlow } from '../services/automation';

const router = Router();

// Helper to get flow with joined accounts
async function getFlowWithAccounts(flowId: number): Promise<FlowWithAccounts | null> {
  return prisma.automationFlow.findUnique({
    where: { id: flowId },
    include: { sourceMailAccount: true, targetMailAccount: true },
  });
}

// Get all automation flows
router.get('/', async (req: Request, res: Response) => {
  try {
    const flowsWithAccounts = await prisma.automationFlow.findMany({
      orderBy: { createdAt: 'desc' },
      include: { sourceMailAccount: true, targetMailAccount: true },
    });

    res.status(HTTP_STATUS.OK).json(flowsWithAccounts);
  } catch (error) {
    console.error('Error fetching automation flows:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ error: 'Failed to fetch flows' });
  }
});

// Get single automation flow
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string);
    const flow = await getFlowWithAccounts(id);

    if (!flow) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ error: ERROR_MESSAGES.FLOW_NOT_FOUND });
    }

    res.status(HTTP_STATUS.OK).json(flow);
  } catch (error) {
    console.error('Error fetching automation flow:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ error: 'Failed to fetch flow' });
  }
});

// Create automation flow
router.post('/', async (req: Request, res: Response) => {
  try {
    const {
      name,
      sourceMailAccountId,
      sourceMailbox,
      targetMailAccountId,
      targetMailbox,
      enabled,
      intervalMinutes,
    } = req.body;

    // Validation
    if (!name || !sourceMailAccountId || !sourceMailbox || !targetMailAccountId || !targetMailbox) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Missing required fields' });
    }

    // Verify accounts exist
    const sourceAccount = await prisma.mailAccount.findUnique({
      where: { id: sourceMailAccountId },
      select: { id: true },
    });
    const targetAccount = await prisma.mailAccount.findUnique({
      where: { id: targetMailAccountId },
      select: { id: true },
    });

    if (!sourceAccount || !targetAccount) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Invalid account IDs' });
    }

    // Calculate next run time
    const now = new Date();
    const nextRun = new Date(now.getTime() + (intervalMinutes || 60) * 60000);

    const created = await prisma.automationFlow.create({
      data: {
        name,
        sourceMailAccountId,
        sourceMailbox,
        targetMailAccountId,
        targetMailbox,
        enabled: enabled !== undefined ? enabled : true,
        intervalMinutes: intervalMinutes || 60,
        nextRun,
      },
    });

    const flow = await getFlowWithAccounts(created.id);
    res.status(HTTP_STATUS.CREATED).json(flow);
  } catch (error) {
    console.error('Error creating automation flow:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ error: 'Failed to create flow' });
  }
});

// Update automation flow
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string);
    const {
      name,
      sourceMailAccountId,
      sourceMailbox,
      targetMailAccountId,
      targetMailbox,
      enabled,
      intervalMinutes,
    } = req.body;

    const existing = await prisma.automationFlow.findUnique({ where: { id } });
    if (!existing) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ error: ERROR_MESSAGES.FLOW_NOT_FOUND });
    }

    // Verify accounts exist if changed (undefined = field not part of the update)
    if (sourceMailAccountId !== undefined && sourceMailAccountId !== existing.sourceMailAccountId) {
      const sourceAccount = await prisma.mailAccount.findUnique({
        where: { id: sourceMailAccountId },
        select: { id: true },
      });
      if (!sourceAccount) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Invalid source account ID' });
      }
    }

    if (targetMailAccountId !== undefined && targetMailAccountId !== existing.targetMailAccountId) {
      const targetAccount = await prisma.mailAccount.findUnique({
        where: { id: targetMailAccountId },
        select: { id: true },
      });
      if (!targetAccount) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Invalid target account ID' });
      }
    }

    await prisma.automationFlow.update({
      where: { id },
      data: {
        name,
        sourceMailAccountId,
        sourceMailbox,
        targetMailAccountId,
        targetMailbox,
        enabled: enabled !== undefined ? enabled : existing.enabled,
        intervalMinutes: intervalMinutes || existing.intervalMinutes,
      },
    });

    const flow = await getFlowWithAccounts(id);
    res.status(HTTP_STATUS.OK).json(flow);
  } catch (error) {
    console.error('Error updating automation flow:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ error: 'Failed to update flow' });
  }
});

// Delete automation flow
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string);

    const existing = await prisma.automationFlow.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ error: ERROR_MESSAGES.FLOW_NOT_FOUND });
    }

    await prisma.automationFlow.delete({ where: { id } });

    res.status(HTTP_STATUS.OK).json({ message: 'Flow deleted successfully' });
  } catch (error) {
    console.error('Error deleting automation flow:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ error: 'Failed to delete flow' });
  }
});

// Run automation flow manually
router.post('/:id/run', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string);
    const flow = await getFlowWithAccounts(id);

    if (!flow) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ error: ERROR_MESSAGES.FLOW_NOT_FOUND });
    }

    // Run the flow
    await runAutomationFlow(flow);

    res.status(HTTP_STATUS.OK).json({ message: 'Flow executed successfully' });
  } catch (error) {
    console.error('Error running automation flow:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ error: 'Failed to run flow' });
  }
});

export default router;
