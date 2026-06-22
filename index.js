const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const crypto = require('crypto');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const Stripe = require('stripe');

dotenv.config({ path: '.env.local' });
dotenv.config();

const app = express();
const port = process.env.PORT || 5000;
const uri = process.env.MONGODB_URI;
const stripeSecretKey = toText(process.env.STRIPE_SECRET_KEY);
const stripe = stripeSecretKey
  ? new Stripe(stripeSecretKey)
  : null;
const allowedOrigins = [
  process.env.CLIENT_URL,
  process.env.FRONTEND_URL,
  process.env.BETTER_AUTH_URL,
  'http://localhost:3000',
].map(toText).filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(null, false);
  },
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const planLimits = {
  Free: 3,
  Growth: 10,
  Enterprise: 50,
};

const defaultPlans = {
  seeker: 'seeker_free',
  recruiter: 'recruiter_free',
};

const planPriceIds = {
  seeker_pro: 'price_1Tib0LDLrgNUOZZUGb5HWPMU',
  seeker_premium: 'price_1TibhCDLrgNUOZZU3czQcfnf',
  recruiter_growth: 'price_1Tibi6DLrgNUOZZUremL7MTn',
  recruiter_enterprise: 'price_1TibijDLrgNUOZZUddfqSfdf',
};

function toText(value) {
  return String(value || '').trim();
}

function toBoolean(value) {
  return value === true || value === 'true' || value === 'on';
}

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(value) {
  const base64 = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');

  return Buffer.from(base64, 'base64').toString('utf8');
}

function getJwtSecret() {
  const secret = toText(process.env.JWT_SECRET);

  if (!secret) {
    throw new Error('JWT_SECRET is missing from your environment variables.');
  }

  return secret;
}

function verifyJwtToken(token) {
  const parts = toText(token).split('.');

  if (parts.length !== 3) {
    throw new Error('Invalid token format.');
  }

  const [encodedHeader, encodedPayload, signature] = parts;
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = base64UrlEncode(
    crypto
      .createHmac('sha256', getJwtSecret())
      .update(unsignedToken)
      .digest()
  );
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    throw new Error('Invalid token signature.');
  }

  const header = JSON.parse(base64UrlDecode(encodedHeader));
  const payload = JSON.parse(base64UrlDecode(encodedPayload));

  if (header.alg !== 'HS256') {
    throw new Error('Invalid token algorithm.');
  }

  if (!payload.exp || Number(payload.exp) <= Math.floor(Date.now() / 1000)) {
    throw new Error('Token expired.');
  }

  return payload;
}

function getBearerToken(req) {
  const authHeader = toText(req.get('authorization'));

  if (!authHeader.startsWith('Bearer ')) {
    return '';
  }

  return authHeader.slice(7).trim();
}

function requireAuth(allowedRoles = []) {
  return (req, res, next) => {
    try {
      const token = getBearerToken(req);

      if (!token) {
        return res.status(401).json({ message: 'Authentication token is required.' });
      }

      const payload = verifyJwtToken(token);
      const userId = toText(payload.userId || payload.sub);
      const role = toText(payload.role);

      if (!userId) {
        return res.status(401).json({ message: 'Invalid authentication token.' });
      }

      if (allowedRoles.length > 0 && !allowedRoles.includes(role)) {
        return res.status(403).json({ message: 'You do not have permission for this action.' });
      }

      req.auth = {
        userId,
        email: toText(payload.email),
        name: toText(payload.name),
        role,
      };

      next();
    } catch (error) {
      return res.status(401).json({ message: 'Invalid or expired authentication token.' });
    }
  };
}

function isSameUser(authUser, userId, userEmail = '') {
  const authUserId = toText(authUser?.userId);
  const authEmail = toText(authUser?.email).toLowerCase();
  const requestedUserId = toText(userId);
  const requestedEmail = toText(userEmail).toLowerCase();

  return (
    (authUserId && requestedUserId && authUserId === requestedUserId) ||
    (authEmail && requestedEmail && authEmail === requestedEmail)
  );
}

function getClientOrigin(req, body = {}) {
  return (
    req.get('origin') ||
    toText(body.origin) ||
    toText(process.env.CLIENT_URL) ||
    toText(process.env.FRONTEND_URL) ||
    toText(process.env.BETTER_AUTH_URL) ||
    'http://localhost:3000'
  );
}

function buildUserLookupFilters(userId) {
  const filters = [];
  const textUserId = toText(userId);

  if (!textUserId) {
    return filters;
  }

  filters.push({ seekerId: textUserId });
  filters.push({ recruiterId: textUserId });
  filters.push({ 'userInfo.id': textUserId });
  filters.push({ 'jobInfo.recruiterId': textUserId });

  return filters;
}

function buildUserFilters(user) {
  const filters = [];
  const userId = toText(user?.id || user?.userId);
  const userEmail = toText(user?.email || user?.userEmail);

  if (userId) {
    filters.push({ id: userId });

    if (ObjectId.isValid(userId)) {
      filters.push({ _id: new ObjectId(userId) });
    }
  }

  if (userEmail) {
    filters.push({ email: userEmail });
  }

  return filters;
}

function buildPlanPaymentFilters(user) {
  const filters = [];
  const userId = toText(user?.id || user?.userId);
  const userEmail = toText(user?.email || user?.userEmail);

  if (userId) {
    filters.push({ userId });
  }

  if (userEmail) {
    filters.push({ userEmail });
  }

  return filters;
}

function buildUserIdFilters(userId) {
  const textUserId = toText(userId);
  const filters = [];

  if (!textUserId) {
    return filters;
  }

  filters.push({ id: textUserId });

  if (ObjectId.isValid(textUserId)) {
    filters.push({ _id: new ObjectId(textUserId) });
  }

  return filters;
}

function getDefaultPlanForRole(role) {
  return defaultPlans[toText(role)] || 'seeker_free';
}

function isPlanExpired(planExpiresAt) {
  if (!planExpiresAt) {
    return false;
  }

  return new Date(planExpiresAt).getTime() <= Date.now();
}

function buildCompanyData(companyData) {
  const now = new Date();
  const id = toText(companyData?.id) || `cmp_${now.getTime()}`;

    return {
    id,
    name: toText(companyData?.name),
    industry: toText(companyData?.industry),
    websiteUrl: toText(companyData?.websiteUrl),
    location: toText(companyData?.location),
    employeeCount: toText(companyData?.employeeCount),
    description: toText(companyData?.description),
    logo: toText(companyData?.logo),
    status: toText(companyData?.status) || 'pending',
    recruiterId: toText(companyData?.recruiterId),
    createdAt: companyData?.createdAt ? new Date(companyData.createdAt) : now,
    updatedAt: now,
  };
}

function normalizeDocument(document) {
  if (!document) {
    return null;
  }

  return {
    ...document,
    _id: document._id?.toString(),
  };
}

async function attachRecruiterEmail(companies, usersCollection) {
  if (!Array.isArray(companies) || companies.length === 0) {
    return [];
  }

  const recruiterIds = [...new Set(
    companies
      .map((company) => toText(company.recruiterId))
      .filter(Boolean)
  )];

  if (recruiterIds.length === 0) {
    return companies.map((company) => ({
      ...company,
      recruiterEmail: '',
    }));
  }

  const objectIds = recruiterIds
    .filter((id) => ObjectId.isValid(id))
    .map((id) => new ObjectId(id));

  const recruiterUsers = await usersCollection
    .find({
      $or: [
        { id: { $in: recruiterIds } },
        ...(objectIds.length > 0 ? [{ _id: { $in: objectIds } }] : []),
      ],
    })
    .toArray();

  const recruiterEmailMap = new Map();

  recruiterUsers.forEach((user) => {
    const userId = toText(user.id || user._id);

    if (userId) {
      recruiterEmailMap.set(userId, toText(user.email));
    }

    const objectId = toText(user._id);

    if (objectId) {
      recruiterEmailMap.set(objectId, toText(user.email));
    }
  });

  return companies.map((company) => ({
    ...company,
    recruiterEmail: recruiterEmailMap.get(toText(company.recruiterId)) || '',
  }));
}

async function attachUserEmailToJobs(jobs, usersCollection) {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return [];
  }

  const recruiterIds = [...new Set(
    jobs
      .map((job) => toText(job.recruiterId || job.company?.recruiterId))
      .filter(Boolean)
  )];

  if (recruiterIds.length === 0) {
    return jobs.map((job) => ({
      ...job,
      recruiterEmail: '',
    }));
  }

  const objectIds = recruiterIds
    .filter((id) => ObjectId.isValid(id))
    .map((id) => new ObjectId(id));

  const recruiterUsers = await usersCollection
    .find({
      $or: [
        { id: { $in: recruiterIds } },
        ...(objectIds.length > 0 ? [{ _id: { $in: objectIds } }] : []),
      ],
    })
    .toArray();

  const recruiterEmailMap = new Map();

  recruiterUsers.forEach((user) => {
    const userId = toText(user.id || user._id);
    if (userId) {
      recruiterEmailMap.set(userId, toText(user.email));
    }

    const objectId = toText(user._id);
    if (objectId) {
      recruiterEmailMap.set(objectId, toText(user.email));
    }
  });

  return jobs.map((job) => ({
    ...job,
    recruiterEmail: recruiterEmailMap.get(toText(job.recruiterId || job.company?.recruiterId)) || '',
  }));
}

function buildJob(body, company) {
  const now = new Date();
  const minSalary = Number(body.minSalary);
  const maxSalary = Number(body.maxSalary);

  return {
    jobTitle: toText(body.jobTitle),
    title: toText(body.jobTitle),
    category: toText(body.category),
    jobType: toText(body.jobType),
    minSalary,
    maxSalary,
    salary: {
      min: minSalary,
      max: maxSalary,
      currency: toText(body.currency),
    },
    currency: toText(body.currency),
    location: toText(body.location),
    isRemote: toBoolean(body.isRemote),
    deadline: toText(body.deadline),
    applicationDeadline: new Date(body.deadline),
    responsibilities: toText(body.responsibilities),
    requirements: toText(body.requirements),
    benefits: toText(body.benefits),
    companyId: toText(body.companyId),
    companyName: company?.name?.trim() || toText(body.companyName),
    companyLogo: company?.logo?.trim() || toText(body.companyLogo),
    companyWebsite: company?.websiteUrl?.trim() || toText(body.companyWebsite),
    companyPlan: toText(body.companyPlan),
    company: {
      id: toText(body.companyId),
      name: company?.name?.trim() || toText(body.companyName),
      logo: company?.logo?.trim() || toText(body.companyLogo),
      websiteUrl: company?.websiteUrl?.trim() || toText(body.companyWebsite),
      plan: toText(body.companyPlan),
      recruiterId: toText(body.recruiterId),
    },
    recruiterId: toText(body.recruiterId),
    status: 'pending',
    visibility: 'public',
    createdAt: now,
    updatedAt: now,
  };
}

function isJobExpired(job) {
  const status = toText(job?.status).toLowerCase();
  if (status === 'expired') {
    return true;
  }

  const deadlineValue = job?.deadline || job?.applicationDeadline;

  if (!deadlineValue) {
    return false;
  }

  const deadlineDate = new Date(deadlineValue);

  if (Number.isNaN(deadlineDate.getTime())) {
    return false;
  }

  return deadlineDate.getTime() < Date.now();
}

function normalizeJobDocument(job) {
  if (!job) {
    return null;
  }

  return {
    ...job,
    _id: job._id?.toString(),
  };
}

function getAdminJobView(job) {
  if (!job?.pendingUpdate) {
    return job;
  }

  return {
    ...job,
    ...job.pendingUpdate,
    _id: job._id,
    status: job.status,
    pendingUpdate: job.pendingUpdate,
    isPendingUpdate: true,
    originalTitle: job.jobTitle || job.title,
  };
}

function buildApplication(body, job) {
  const now = new Date();
  const seekerId = toText(body.seekerId);
  const jobId = job._id.toString();

  return {
    seekerId,
    jobId,
    userInfo: {
      id: seekerId,
      name: toText(body.fullName),
      email: toText(body.email),
    },
    jobInfo: {
      id: jobId,
      title: job.jobTitle || job.title || 'Untitled job',
      companyName: job.companyName || job.company?.name || 'N/A',
      category: job.category || 'N/A',
      jobType: job.jobType || 'N/A',
      location: job.location || (job.isRemote ? 'Remote' : 'N/A'),
    },
    applicationInfo: {
      fullName: toText(body.fullName),
      email: toText(body.email),
      resumeLink: toText(body.resumeLink),
      portfolioLink: toText(body.portfolioLink),
      message: toText(body.message),
    },
    status: 'applied',
    appliedAt: now,
    createdAt: now,
  };
}

function buildPlanPurchase(body) {
  const now = new Date();

  return {
    userId: toText(body.userId),
    userName: toText(body.userName),
    userEmail: toText(body.userEmail),
    role: toText(body.role),
    planId: toText(body.planId),
    planName: toText(body.planName),
    stripeSessionId: toText(body.stripeSessionId),
    stripeCustomerId: toText(body.stripeCustomerId),
    stripeSubscriptionId: toText(body.stripeSubscriptionId),
    amountTotal: Number(body.amountTotal || 0),
    currency: toText(body.currency),
    paymentStatus: toText(body.paymentStatus),
    planStartedAt: body.planStartedAt ? new Date(body.planStartedAt) : now,
    planExpiresAt: body.planExpiresAt ? new Date(body.planExpiresAt) : null,
    createdAt: now,
    updatedAt: now,
  };
}

async function run() {
  try {
    await client.connect();

    const database = client.db(process.env.DATABASE_NAME);
    const jobsCollection = database.collection('jobs');
    const companiesCollection = database.collection('companies');
    const applicationsCollection = database.collection('applications');
    const savedJobsCollection = database.collection('savedJobs');
    const plansCollection = database.collection('plansCollection');
    const usersCollection = database.collection('user');

    async function requireActiveAccount(req, res, next) {
      try {
        if (req.auth.role === 'admin') {
          next();
          return;
        }

        const userFilters = buildUserIdFilters(req.auth.userId);

        if (req.auth.email) {
          userFilters.push({ email: req.auth.email });
        }

        const user = await usersCollection.findOne({ $or: userFilters });
        const status = toText(user?.status).toLowerCase() || 'pending';
        const isSuspended = Boolean(user?.suspended || user?.banned);

        if (!user || status !== 'active' || isSuspended) {
          return res.status(403).json({
            message: isSuspended
              ? 'Your account is suspended. Please contact admin.'
              : 'Your account is pending admin approval.',
          });
        }

        next();
      } catch (error) {
        console.error('Failed to check account status', error);
        return res.status(500).json({ message: 'Failed to check account status.' });
      }
    }



    app.post('/checkout_sessions', requireAuth(['seeker', 'recruiter']), requireActiveAccount, async (req, res) => {
      try {
        if (!stripe) {
          return res.status(500).json({ error: 'STRIPE_SECRET_KEY is missing.' });
        }

        const body = req.body || {};
        const planId = toText(body.planId);
        const priceId = planPriceIds[planId];
        const userId = req.auth.userId;
        const userEmail = req.auth.email;
        const userRole = req.auth.role;
        const origin = getClientOrigin(req, body);
        const isSeekerPlan = planId.startsWith('seeker_');
        const isRecruiterPlan = planId.startsWith('recruiter_');

        if (!priceId) {
          return res.status(400).json({ error: 'Invalid plan selected' });
        }

        if (!userId || !userEmail) {
          return res.status(401).json({ error: 'Please sign in first' });
        }

        if (
          (userRole === 'seeker' && !isSeekerPlan) ||
          (userRole === 'recruiter' && !isRecruiterPlan) ||
          (!isSeekerPlan && !isRecruiterPlan)
        ) {
          return res.status(400).json({
            error: 'This plan does not match your account role',
          });
        }

        const session = await stripe.checkout.sessions.create({
          customer_email: userEmail,
          metadata: {
            planId,
            userId,
            role: userRole,
          },
          line_items: [
            {
              price: priceId,
              quantity: 1,
            },
          ],
          mode: 'subscription',
          success_url: `${origin}/plans/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${origin}/plans`,
        });

        if (req.accepts('json')) {
          return res.json({ url: session.url });
        }

        return res.redirect(303, session.url);
      } catch (error) {
        console.error('Failed to create checkout session', error);
        return res.status(error.statusCode || 500).json({
          error: error.message || 'Failed to create checkout session',
        });
      }
    });

    app.get('/checkout_sessions/:sessionId', requireAuth(['seeker', 'recruiter', 'admin']), async (req, res) => {
      try {
        if (!stripe) {
          return res.status(500).json({ error: 'STRIPE_SECRET_KEY is missing.' });
        }

        const session = await stripe.checkout.sessions.retrieve(
          toText(req.params.sessionId),
          {
            expand: ['line_items', 'payment_intent'],
          }
        );

        if (
          req.auth.role !== 'admin' &&
          toText(session.metadata?.userId) !== req.auth.userId
        ) {
          return res.status(403).json({ error: 'You can only view your own checkout session.' });
        }

        return res.json(session);
      } catch (error) {
        console.error('Failed to load checkout session', error);
        return res.status(error.statusCode || 500).json({
          error: error.message || 'Failed to load checkout session',
        });
      }
    });

    app.post('/jobs', requireAuth(['recruiter']), requireActiveAccount, async (req, res) => {
      try {
        const body = req.body || {};
        body.recruiterId = req.auth.userId;

        const requiredFields = [
          'jobTitle',
          'category',
          'jobType',
          'currency',
          'deadline',
          'responsibilities',
          'requirements',
          'companyId',
          'companyName',
          'companyPlan',
          'recruiterId',
        ];

        const missingField = requiredFields.find((field) => !toText(body[field]));

        if (missingField) {
          return res.status(400).json({ message: `${missingField} is required.` });
        }

        if (!toBoolean(body.isRemote) && !toText(body.location)) {
          return res.status(400).json({
            message: 'Location is required for non-remote jobs.',
          });
        }

        const minSalary = Number(body.minSalary);
        const maxSalary = Number(body.maxSalary);

        if (!Number.isFinite(minSalary) || !Number.isFinite(maxSalary)) {
          return res.status(400).json({
            message: 'Salary range must include valid minimum and maximum values.',
          });
        }

        if (minSalary < 0 || maxSalary < minSalary) {
          return res.status(400).json({
            message: 'Salary range is invalid.',
          });
        }

        const company = await companiesCollection.findOne({
          id: toText(body.companyId),
          recruiterId: toText(body.recruiterId),
        });

        if (!company) {
          return res.status(404).json({
            message: 'Company not found for this recruiter.',
          });
        }

        if (toText(company.status) !== 'approved') {
          return res.status(403).json({
            message:
              toText(company.status) === 'pending'
                ? 'Please wait to get approval.'
                : 'This company is not approved for job posting yet.',
          });
        }

        const jobLimit = planLimits[toText(body.companyPlan)];

        if (!jobLimit) {
          return res.status(400).json({
            message: 'Company plan is invalid.',
          });
        }

        const activeJobs = await jobsCollection.countDocuments({
          'company.id': toText(body.companyId),
          status: 'approved',
        });

        if (activeJobs >= jobLimit) {
          return res.status(403).json({
            message: `This company has reached its ${body.companyPlan} plan limit.`,
          });
        }

        const job = buildJob(body, company);
        const result = await jobsCollection.insertOne(job);

        return res.status(201).json({
          message: 'Job posted successfully.',
          jobId: result.insertedId.toString(),
          activeJobs: activeJobs + 1,
          job,
        });
      } catch (error) {
        console.error('Failed to create job', error);

        return res.status(500).json({
          message: 'Something went wrong while posting the job.',
        });
      }
    });

    app.patch('/jobs/:jobId', requireAuth(['recruiter']), requireActiveAccount, async (req, res) => {
      try {
        const jobId = toText(req.params.jobId);
        const body = req.body || {};

        if (!ObjectId.isValid(jobId)) {
          return res.status(400).json({ message: 'Invalid job id.' });
        }

        const existingJob = await jobsCollection.findOne({ _id: new ObjectId(jobId) });

        if (!existingJob) {
          return res.status(404).json({ message: 'Job not found.' });
        }

        const ownerId = toText(existingJob.recruiterId || existingJob.company?.recruiterId);

        if (ownerId !== req.auth.userId) {
          return res.status(403).json({ message: 'You can only update your own jobs.' });
        }

        const company = await companiesCollection.findOne({
          id: toText(body.companyId || existingJob.companyId || existingJob.company?.id),
          recruiterId: req.auth.userId,
        });

        if (!company) {
          return res.status(404).json({ message: 'Company not found for this recruiter.' });
        }

        const job = buildJob({
          ...existingJob,
          ...body,
          recruiterId: req.auth.userId,
          companyId: company.id,
          companyName: company.name,
          companyLogo: company.logo,
          companyPlan: body.companyPlan || existingJob.companyPlan || company.plan || "Free",
          status: 'pending',
        }, company);

        delete job._id;

        if (toText(existingJob.status).toLowerCase() === 'approved') {
          await jobsCollection.updateOne(
            { _id: new ObjectId(jobId) },
            {
              $set: {
                status: 'pending',
                previousStatus: 'approved',
                pendingUpdate: {
                  ...job,
                  createdAt: existingJob.createdAt || job.createdAt,
                  updatedAt: new Date(),
                },
                updatedAt: new Date(),
              },
            }
          );

          const savedJob = await jobsCollection.findOne({ _id: new ObjectId(jobId) });

          return res.json({
            message: 'Job update sent for admin approval.',
            job: normalizeJobDocument(savedJob),
          });
        }

        await jobsCollection.updateOne(
          { _id: new ObjectId(jobId) },
          {
            $set: {
              ...job,
              createdAt: existingJob.createdAt || job.createdAt,
              updatedAt: new Date(),
            },
          }
        );

        const savedJob = await jobsCollection.findOne({ _id: new ObjectId(jobId) });

        return res.json({
          message: 'Job updated successfully.',
          job: normalizeJobDocument(savedJob),
        });
      } catch (error) {
        console.error('Failed to update job', error);
        return res.status(500).json({
          message: 'Something went wrong while updating the job.',
        });
      }
    });

    app.delete('/jobs/:jobId', requireAuth(['recruiter']), requireActiveAccount, async (req, res) => {
      try {
        const jobId = toText(req.params.jobId);

        if (!ObjectId.isValid(jobId)) {
          return res.status(400).json({ message: 'Invalid job id.' });
        }

        const existingJob = await jobsCollection.findOne({ _id: new ObjectId(jobId) });

        if (!existingJob) {
          return res.status(404).json({ message: 'Job not found.' });
        }

        const ownerId = toText(existingJob.recruiterId || existingJob.company?.recruiterId);

        if (ownerId !== req.auth.userId) {
          return res.status(403).json({ message: 'You can only delete your own jobs.' });
        }

        await jobsCollection.deleteOne({ _id: new ObjectId(jobId) });

        return res.json({
          message: 'Job deleted successfully.',
        });
      } catch (error) {
        console.error('Failed to delete job', error);
        return res.status(500).json({
          message: 'Something went wrong while deleting the job.',
        });
      }
    });


    app.get('/alljobs', async (req, res) => {
      try {
        const jobs = await jobsCollection
          .find({ status: 'approved' })
          .sort({ createdAt: -1, _id: -1 })
          .toArray();

        return res.json(jobs);
      } catch (error) {
        console.error('Failed to load all jobs', error);
        return res.status(500).json([]);
      }
    }
     
    )

    app.get('/job/:id', async (req, res) => {
      try {
        const jobId = toText(req.params.id);

        if (!ObjectId.isValid(jobId)) {
          return res.status(400).json({ message: 'Invalid job id.' });
        }

        const token = getBearerToken(req);
        let authUser = null;

        if (token) {
          try {
            authUser = verifyJwtToken(token);
          } catch {
            authUser = null;
          }
        }

        const job = await jobsCollection.findOne({
          _id: new ObjectId(jobId),
        });

        if (!job) {
          return res.status(404).json({ message: 'Job not found.' });
        }

        const jobStatus = toText(job.status).toLowerCase();
        const authUserId = toText(authUser?.userId || authUser?.sub);
        const authRole = toText(authUser?.role);
        const isOwner = authRole === 'recruiter' && authUserId && (
          toText(job.recruiterId) === authUserId ||
          toText(job.company?.recruiterId) === authUserId
        );
        const canViewPrivateJob = authRole === 'admin' || isOwner;

        if (jobStatus !== 'approved' && !canViewPrivateJob) {
          return res.status(404).json({ message: 'Job not found.' });
        }

        return res.json(job);
      } catch (error) {
        console.error('Failed to load job details', error);
        return res.status(500).json({ message: 'Failed to load job details.' });
      }
    });

    app.get('/jobs/:companyId/:status', requireAuth(['recruiter']), async (req, res) => {
      try {
        const companyId = toText(req.params.companyId);
        const status = toText(req.params.status).toLowerCase();
        const query = {
          $and: [
            {
              $or: [
                { 'company.id': companyId },
                { companyId },
              ],
            },
            {
              $or: [
                { recruiterId: req.auth.userId },
                { 'company.recruiterId': req.auth.userId },
              ],
            },
          ],
        };

        if (status && status !== 'all') {
          query.status = status;
        }

        const jobs = await jobsCollection
          .find(query)
          .sort({ createdAt: -1, _id: -1 })
          .toArray();

        return res.json(jobs);
      } catch (error) {
        console.error('Failed to load jobs', error);
        return res.status(500).json([]);
      }
    });

    app.get('/jobs/recruiter/:recruiterId/:status', requireAuth(['recruiter']), async (req, res) => {
      try {
        const recruiterId = toText(req.params.recruiterId);
        const status = toText(req.params.status).toLowerCase();

        if (recruiterId !== req.auth.userId) {
          return res.status(403).json({ message: 'You can only view your own jobs.' });
        }

        const query = {
          $or: [
            { recruiterId },
            { 'company.recruiterId': recruiterId },
          ],
        };

        if (status && status !== 'all') {
          query.status = status;
        }

        const jobs = await jobsCollection
          .find(query)
          .sort({ createdAt: -1, _id: -1 })
          .toArray();

        return res.json(jobs);
      } catch (error) {
        console.error('Failed to load recruiter jobs', error);
        return res.status(500).json([]);
      }
    });

    app.post('/applications', requireAuth(['seeker']), requireActiveAccount, async (req, res) => {
      try {
        const body = req.body || {};
        body.seekerId = req.auth.userId;
        body.email = req.auth.email || toText(body.email);

        const requiredFields = ['seekerId', 'jobId', 'fullName', 'email', 'resumeLink'];
        const missingField = requiredFields.find((field) => !toText(body[field]));

        if (missingField) {
          return res.status(400).json({ message: `${missingField} is required.` });
        }

        if (!ObjectId.isValid(toText(body.jobId))) {
          return res.status(400).json({ message: 'Invalid job id.' });
        }

        const job = await jobsCollection.findOne({
          _id: new ObjectId(toText(body.jobId)),
          status: 'approved',
        });

        if (!job) {
          return res.status(404).json({ message: 'Job not found.' });
        }

        const oldApplication = await applicationsCollection.findOne({
          seekerId: toText(body.seekerId),
          jobId: toText(body.jobId),
        });

        if (oldApplication) {
          return res.status(409).json({
            message: 'You already applied for this job.',
          });
        }

        const application = buildApplication(body, job);
        const result = await applicationsCollection.insertOne(application);
        await savedJobsCollection.deleteOne({
          seekerId: toText(body.seekerId),
          jobId: toText(body.jobId),
        });

        return res.status(201).json({
          message: 'Application submitted successfully.',
          applicationId: result.insertedId.toString(),
          application,
        });
      } catch (error) {
        console.error('Failed to submit application', error);
        return res.status(500).json({
          message: 'Something went wrong while submitting the application.',
        });
      }
    });

    app.get('/applications/job/:jobId', requireAuth(['recruiter']), async (req, res) => {
      try {
        const jobId = toText(req.params.jobId);

        if (!ObjectId.isValid(jobId)) {
          return res.status(400).json({ message: 'Invalid job id.' });
        }

        const job = await jobsCollection.findOne({ _id: new ObjectId(jobId) });

        if (!job) {
          return res.status(404).json({ message: 'Job not found.' });
        }

        const ownerId = toText(job.recruiterId || job.company?.recruiterId);

        if (ownerId !== req.auth.userId) {
          return res.status(403).json({ message: 'You can only view applications for your own jobs.' });
        }

        const applications = await applicationsCollection
          .find({ jobId })
          .sort({ appliedAt: -1, _id: -1 })
          .toArray();

        return res.json(applications.map((application) => ({
          ...application,
          _id: application._id?.toString(),
        })));
      } catch (error) {
        console.error('Failed to load job applications', error);
        return res.status(500).json([]);
      }
    });

    app.patch('/applications/:applicationId/status', requireAuth(['recruiter']), requireActiveAccount, async (req, res) => {
      try {
        const applicationId = toText(req.params.applicationId);
        const nextStatus = toText(req.body?.status).toLowerCase();
        const allowedStatuses = ['interview', 'rejected', 'hired'];

        if (!ObjectId.isValid(applicationId)) {
          return res.status(400).json({ message: 'Invalid application id.' });
        }

        if (!allowedStatuses.includes(nextStatus)) {
          return res.status(400).json({ message: 'Invalid application status.' });
        }

        const application = await applicationsCollection.findOne({ _id: new ObjectId(applicationId) });

        if (!application) {
          return res.status(404).json({ message: 'Application not found.' });
        }

        const jobId = toText(application.jobId || application.jobInfo?.id);

        if (!ObjectId.isValid(jobId)) {
          return res.status(400).json({ message: 'Invalid job id.' });
        }

        const job = await jobsCollection.findOne({ _id: new ObjectId(jobId) });

        if (!job) {
          return res.status(404).json({ message: 'Job not found.' });
        }

        const ownerId = toText(job.recruiterId || job.company?.recruiterId);

        if (ownerId !== req.auth.userId) {
          return res.status(403).json({ message: 'You can only update applications for your own jobs.' });
        }

        const currentStatus = toText(application.status).toLowerCase();
        const canMoveToInterview = ['applied', 'submitted', 'review'].includes(currentStatus) && nextStatus === 'interview';
        const canRejectBeforeInterview = ['applied', 'submitted', 'review'].includes(currentStatus) && nextStatus === 'rejected';
        const canFinishInterview = currentStatus === 'interview' && ['hired', 'rejected'].includes(nextStatus);

        if (!canMoveToInterview && !canRejectBeforeInterview && !canFinishInterview) {
          return res.status(400).json({ message: 'This status change is not allowed.' });
        }

        await applicationsCollection.updateOne(
          { _id: new ObjectId(applicationId) },
          {
            $set: {
              status: nextStatus,
              updatedAt: new Date(),
            },
          }
        );

        const updatedApplication = await applicationsCollection.findOne({ _id: new ObjectId(applicationId) });

        return res.json({
          message: 'Application status updated successfully.',
          application: {
            ...updatedApplication,
            _id: updatedApplication._id?.toString(),
          },
        });
      } catch (error) {
        console.error('Failed to update application status', error);
        return res.status(500).json({ message: 'Something went wrong while updating the application.' });
      }
    });

    app.get('/saved-jobs/seeker/:seekerId', requireAuth(['seeker']), async (req, res) => {
      try {
        const seekerId = toText(req.params.seekerId);

        if (!isSameUser(req.auth, seekerId, req.query.email)) {
          return res.status(403).json({ message: 'You can only view your own saved jobs.' });
        }

        const savedJobs = await savedJobsCollection
          .find({ seekerId })
          .sort({ savedAt: -1, _id: -1 })
          .toArray();

        return res.json(savedJobs);
      } catch (error) {
        console.error('Failed to load saved jobs', error);
        return res.status(500).json([]);
      }
    });

    app.post('/saved-jobs', requireAuth(['seeker']), requireActiveAccount, async (req, res) => {
      try {
        const body = req.body || {};
        const seekerId = req.auth.userId;
        const jobId = toText(body.jobId);

        if (!ObjectId.isValid(jobId)) {
          return res.status(400).json({ message: 'Invalid job id.' });
        }

        const oldApplication = await applicationsCollection.findOne({ seekerId, jobId });

        if (oldApplication) {
          return res.status(409).json({ message: 'You already applied for this job.' });
        }

        const job = await jobsCollection.findOne({
          _id: new ObjectId(jobId),
          status: 'approved',
        });

        if (!job) {
          return res.status(404).json({ message: 'Job not found.' });
        }

        const now = new Date();
        const savedJob = {
          seekerId,
          seekerEmail: req.auth.email || '',
          jobId,
          jobInfo: {
            id: jobId,
            title: job.jobTitle || job.title || 'Untitled job',
            companyName: job.companyName || job.company?.name || 'N/A',
            category: job.category || 'N/A',
            jobType: job.jobType || 'N/A',
            location: job.location || (job.isRemote ? 'Remote' : 'N/A'),
            deadline: job.deadline || job.applicationDeadline || null,
          },
          savedAt: now,
          updatedAt: now,
        };

        await savedJobsCollection.updateOne(
          { seekerId, jobId },
          { $set: savedJob, $setOnInsert: { createdAt: now } },
          { upsert: true }
        );

        return res.status(201).json({
          message: 'Job saved successfully.',
          savedJob,
        });
      } catch (error) {
        console.error('Failed to save job', error);
        return res.status(500).json({ message: 'Something went wrong while saving the job.' });
      }
    });

    app.delete('/saved-jobs/:jobId', requireAuth(['seeker']), async (req, res) => {
      try {
        const jobId = toText(req.params.jobId);

        if (!ObjectId.isValid(jobId)) {
          return res.status(400).json({ message: 'Invalid job id.' });
        }

        await savedJobsCollection.deleteOne({
          seekerId: req.auth.userId,
          jobId,
        });

        return res.json({ message: 'Saved job removed successfully.' });
      } catch (error) {
        console.error('Failed to remove saved job', error);
        return res.status(500).json({ message: 'Something went wrong while removing the saved job.' });
      }
    });


    app.post('/plans', requireAuth(['seeker', 'recruiter']), requireActiveAccount, async (req, res) => {
      try {
        const body = req.body || {};
        body.role = req.auth.role;

        const requiredFields = ['userId', 'role', 'planId', 'planName', 'stripeSessionId'];
        const missingField = requiredFields.find((field) => !toText(body[field]));

        if (missingField) {
          return res.status(400).json({ message: `${missingField} is required.` });
        }

        if (!isSameUser(req.auth, body.userId, body.userEmail)) {
          return res.status(403).json({ message: 'You can only save your own plan.' });
        }

        const planPurchase = buildPlanPurchase(body);

        await plansCollection.updateOne(
          { stripeSessionId: planPurchase.stripeSessionId },
          { $setOnInsert: planPurchase },
          { upsert: true }
        );

        return res.status(201).json({
          message: 'Plan information saved successfully.',
          plan: planPurchase,
        });
      } catch (error) {
        console.error('Failed to save plan information', error);
        return res.status(500).json({
          message: 'Something went wrong while saving the plan information.',
        });
      }
    });

    app.get('/plans/payments', requireAuth(['admin']), async (req, res) => {
      try {
        const payments = await plansCollection
          .find({})
          .sort({ createdAt: -1, _id: -1 })
          .toArray();

        return res.json(payments.map((payment) => ({
          ...payment,
          _id: payment._id?.toString(),
        })));
      } catch (error) {
        console.error('Failed to load payment details', error);
        return res.status(500).json([]);
      }
    });

    app.get('/plans/user/:userId', requireAuth(['seeker', 'recruiter', 'admin']), async (req, res) => {
      try {
        const userId = toText(req.params.userId);
        const userEmail = toText(req.query.email);

        if (req.auth.role !== 'admin' && !isSameUser(req.auth, userId, userEmail)) {
          return res.status(403).json({ message: 'You can only view your own billing information.' });
        }

        const filters = buildPlanPaymentFilters({
          id: userId,
          email: userEmail,
        });

        if (filters.length === 0) {
          return res.json([]);
        }

        const payments = await plansCollection
          .find({ $or: filters })
          .sort({ createdAt: -1, _id: -1 })
          .toArray();

        return res.json(payments.map((payment) => ({
          ...payment,
          _id: payment._id?.toString(),
        })));
      } catch (error) {
        console.error('Failed to load user billing information', error);
        return res.status(500).json([]);
      }
    });

    app.post('/users/plan-status', requireAuth(['seeker', 'recruiter', 'admin']), async (req, res) => {
      try {
        const body = req.body || {};
        const user = {
          ...(body.user || {}),
          id: req.auth.userId,
          email: req.auth.email || body.user?.email,
          role: req.auth.role || body.user?.role,
        };
        const fallbackPlan = toText(body.fallbackPlan) || 'seeker_free';
        const userFilters = buildUserFilters(user);

        if (userFilters.length === 0) {
          return res.json({
            plan: toText(user.plan) || fallbackPlan,
            planExpiresAt: user.planExpiresAt || null,
            isExpired: false,
            status: toText(user.status) || 'pending',
            suspended: Boolean(user.suspended || user.banned),
          });
        }

        const savedUser = await usersCollection.findOne({ $or: userFilters });
        const currentUser = savedUser || user;
        const freePlan = getDefaultPlanForRole(currentUser.role || user.role);

        if (isPlanExpired(currentUser.planExpiresAt)) {
          await usersCollection.updateOne(
            { $or: userFilters },
            {
              $set: {
                plan: freePlan,
                planExpiredAt: new Date(),
              },
              $unset: {
                planExpiresAt: '',
                planStartedAt: '',
              },
            }
          );

          return res.json({
            plan: freePlan,
            planExpiresAt: null,
            isExpired: true,
            status: toText(currentUser.status) || 'pending',
            suspended: Boolean(currentUser.suspended || currentUser.banned),
          });
        }

        return res.json({
          plan: currentUser.plan || fallbackPlan,
          planExpiresAt: currentUser.planExpiresAt || null,
          isExpired: false,
          status: toText(currentUser.status) || 'pending',
          suspended: Boolean(currentUser.suspended || currentUser.banned),
        });
      } catch (error) {
        console.error('Failed to load user plan status', error);
        return res.status(500).json({
          message: 'Something went wrong while loading the user plan.',
        });
      }
    });

    app.patch('/users/plan', requireAuth(['seeker', 'recruiter']), requireActiveAccount, async (req, res) => {
      try {
        const body = req.body || {};

        if (!isSameUser(req.auth, body.userId, body.userEmail)) {
          return res.status(403).json({ message: 'You can only update your own plan.' });
        }

        const userFilters = buildUserFilters(body);

        if (userFilters.length === 0) {
          return res.status(400).json({ message: 'User id or email is required.' });
        }

        await usersCollection.updateOne(
          { $or: userFilters },
          {
            $set: {
              plan: toText(body.planId),
              planStartedAt: body.planStartedAt ? new Date(body.planStartedAt) : new Date(),
              planExpiresAt: body.planExpiresAt ? new Date(body.planExpiresAt) : null,
            },
            $unset: {
              planExpiredAt: '',
            },
          }
        );

        return res.json({ message: 'User plan updated successfully.' });
      } catch (error) {
        console.error('Failed to update user plan', error);
        return res.status(500).json({
          message: 'Something went wrong while updating the user plan.',
        });
      }
    });

    app.get('/companies/recruiter/:recruiterId', requireAuth(['recruiter']), async (req, res) => {
      try {
        const recruiterId = toText(req.params.recruiterId);

        if (!recruiterId) {
          return res.status(400).json({ message: 'recruiterId is required.' });
        }

        if (recruiterId !== req.auth.userId) {
          return res.status(403).json({ message: 'You can only view your own companies.' });
        }

        const companies = await companiesCollection
          .find({ recruiterId })
          .sort({ createdAt: -1 })
          .toArray();

        return res.json(companies.map(normalizeDocument));
      } catch (error) {
        console.error('Failed to load companies', error);
        return res.status(500).json([]);
      }
    });

    app.get('/companies', async (req, res) => {
      try {
        const companies = await companiesCollection
          .find({ status: 'approved' })
          .sort({ createdAt: -1 })
          .toArray();

        return res.json(companies.map(normalizeDocument));
      } catch (error) {
        console.error('Failed to load companies', error);
        return res.status(500).json([]);
      }
    });

    app.get('/admin/companies', requireAuth(['admin']), async (req, res) => {
      try {
        const status = toText(req.query.status);
        const filters = status && status !== 'all' ? { status } : {};

        const companies = await companiesCollection
          .find(filters)
          .sort({ createdAt: -1, _id: -1 })
          .toArray();

        const companyIds = companies
          .map((company) => toText(company.id))
          .filter(Boolean);

        let jobsCountByCompanyId = {};

        if (companyIds.length > 0) {
          const jobCounts = await jobsCollection
            .aggregate([
              {
                $match: {
                  $or: [
                    { 'company.id': { $in: companyIds } },
                    { companyId: { $in: companyIds } },
                  ],
                },
              },
              {
                $project: {
                  companyKey: {
                    $ifNull: ['$company.id', '$companyId'],
                  },
                },
              },
              {
                $group: {
                  _id: '$companyKey',
                  jobsCount: { $sum: 1 },
                },
              },
            ])
            .toArray();

          jobsCountByCompanyId = jobCounts.reduce((counts, item) => {
            counts[toText(item._id)] = Number(item.jobsCount) || 0;
            return counts;
          }, {});
        }

        const companiesWithRecruiterEmail = await attachRecruiterEmail(
          companies.map(normalizeDocument),
          usersCollection
        );

        const companiesWithJobsCount = companiesWithRecruiterEmail.map((company) => ({
          ...company,
          jobsCount: jobsCountByCompanyId[toText(company.id)] || 0,
        }));

        return res.json(companiesWithJobsCount);
      } catch (error) {
        console.error('Failed to load admin companies', error);
        return res.status(500).json([]);
      }
    });

    app.patch('/users/profile', requireAuth(['seeker', 'recruiter']), requireActiveAccount, async (req, res) => {
      try {
        const body = req.body || {};
        const filters = buildUserIdFilters(req.auth.userId);

        if (filters.length === 0) {
          return res.status(400).json({ message: 'User id is required.' });
        }

        const existingUser = await usersCollection.findOne({ $or: filters });

        if (!existingUser) {
          return res.status(404).json({ message: 'User was not found.' });
        }

        const name = toText(body.name || existingUser.name);
        const email = toText(body.email || existingUser.email).toLowerCase();

        const rawPhoto = body.photo !== undefined ? body.photo : body.image !== undefined ? body.image : body.avatar;
        const rawAvatar = body.avatar !== undefined ? body.avatar : body.photo !== undefined ? body.photo : body.image;
        const photo = toText(rawPhoto || existingUser.photo || existingUser.image || existingUser.avatar);
        const avatar = toText(rawAvatar || existingUser.avatar || existingUser.photo || existingUser.image);
        const headline = body.headline !== undefined ? toText(body.headline) : toText(existingUser.headline);
        const bio = body.bio !== undefined ? toText(body.bio) : toText(existingUser.bio);
        const skills = body.skills !== undefined
          ? (Array.isArray(body.skills)
              ? body.skills.map(toText).filter(Boolean)
              : toText(body.skills).split(',').map(toText).filter(Boolean))
          : existingUser.skills || [];

        if (!name) {
          return res.status(400).json({ message: 'Name is required.' });
        }

        if (!email) {
          return res.status(400).json({ message: 'Email is required.' });
        }

        const sameEmailUser = await usersCollection.findOne({
          email,
          $nor: [
            { id: req.auth.userId },
            { _id: existingUser._id },
          ],
        });

        if (sameEmailUser) {
          return res.status(409).json({ message: 'This email is already used by another account.' });
        }

        const updateData = {
          name,
          email,
          photo,
          image: photo,
          avatar,
          headline,
          bio,
          skills,
          updatedAt: new Date(),
        };

        await usersCollection.updateOne(
          { $or: filters },
          { $set: updateData }
        );

        const updatedUser = await usersCollection.findOne({ $or: filters });

        return res.json({
          message: 'Profile updated successfully.',
          user: {
            ...updatedUser,
            _id: updatedUser._id?.toString(),
          },
        });
      } catch (error) {
        console.error('Failed to update profile', error);
        return res.status(500).json({ message: 'Something went wrong while updating your profile.' });
      }
    });

    app.get('/users/profile', requireAuth(['seeker', 'recruiter']), requireActiveAccount, async (req, res) => {
      try {
        const filters = buildUserIdFilters(req.auth.userId);

        if (filters.length === 0) {
          return res.status(400).json({ message: 'User id is required.' });
        }

        const user = await usersCollection.findOne({ $or: filters });

        if (!user) {
          return res.status(404).json({ message: 'User was not found.' });
        }

        return res.json({
          ...user,
          _id: user._id?.toString(),
        });
      } catch (error) {
        console.error('Failed to load profile', error);
        return res.status(500).json({ message: 'Something went wrong while loading your profile.' });
      }
    });

    app.get('/admin/users', requireAuth(['admin']), async (req, res) => {
      try {
        const role = toText(req.query.role).toLowerCase();
        const filters = role && role !== 'all' ? { role } : {};
        const users = await usersCollection
          .find(filters)
          .sort({ createdAt: -1, _id: -1 })
          .toArray();

        return res.json(users.map((user) => ({
          ...user,
          _id: user._id?.toString(),
        })));
      } catch (error) {
        console.error('Failed to load admin users', error);
        return res.status(500).json([]);
      }
    });

    app.patch('/admin/users/:userId', requireAuth(['admin']), async (req, res) => {
      try {
        const userId = toText(req.params.userId);
        const filters = buildUserIdFilters(userId);

        if (filters.length === 0) {
          return res.status(400).json({ message: 'User id is required.' });
        }

        const user = await usersCollection.findOne({ $or: filters });

        if (!user) {
          return res.status(404).json({ message: 'User was not found.' });
        }

        const targetUserId = toText(user.id || user._id);
        const adminUserId = toText(req.auth.userId);

        if (targetUserId && adminUserId && targetUserId === adminUserId) {
          return res.status(400).json({ message: 'You cannot update your own admin account here.' });
        }

        const allowedRoles = ['admin', 'seeker', 'recruiter'];
        const allowedStatuses = ['pending', 'active'];
        const nextRole = toText(req.body.role).toLowerCase();
        const nextStatus = toText(req.body.status).toLowerCase();
        const hasSuspended = Object.prototype.hasOwnProperty.call(req.body, 'suspended');
        const updateData = {
          updatedAt: new Date(),
        };

        if (nextRole) {
          if (!allowedRoles.includes(nextRole)) {
            return res.status(400).json({ message: 'Role must be admin, seeker, or recruiter.' });
          }

          updateData.role = nextRole;
          updateData.plan = getDefaultPlanForRole(nextRole);
        }

        if (nextStatus) {
          if (!allowedStatuses.includes(nextStatus)) {
            return res.status(400).json({ message: 'Status must be pending or active.' });
          }

          updateData.status = nextStatus;
        }

        if (hasSuspended) {
          const isSuspended = toBoolean(req.body.suspended);
          updateData.suspended = isSuspended;
          updateData.banned = isSuspended;
          updateData.banReason = isSuspended ? 'Suspended by admin.' : null;
          updateData.banExpires = null;
        }

        if (Object.keys(updateData).length === 1) {
          return res.status(400).json({ message: 'Nothing to update.' });
        }

        await usersCollection.updateOne(
          { _id: user._id },
          { $set: updateData }
        );

        const updatedUser = await usersCollection.findOne({ _id: user._id });

        return res.json({
          message: 'User updated successfully.',
          user: normalizeDocument(updatedUser),
        });
      } catch (error) {
        console.error('Failed to update admin user', error);
        return res.status(500).json({ message: 'Failed to update user.' });
      }
    });

    app.get('/admin/jobs', requireAuth(['admin']), async (req, res) => {
      try {
        const status = toText(req.query.status).toLowerCase();
        const filters = status && status !== 'all' ? { status } : {};
        const jobs = await jobsCollection
          .find(filters)
          .sort({ createdAt: -1, _id: -1 })
          .toArray();

        const jobsWithEmails = await attachUserEmailToJobs(
          jobs.map(normalizeJobDocument),
          usersCollection
        );

        return res.json(jobsWithEmails);
      } catch (error) {
        console.error('Failed to load admin jobs', error);
        return res.status(500).json([]);
      }
    });

    app.get('/admin/jobs/stats', requireAuth(['admin']), async (req, res) => {
      try {
        const jobs = await jobsCollection.find({}).toArray();

        const stats = jobs.reduce((result, job) => {
          const status = toText(job.status).toLowerCase();

          if (isJobExpired(job)) {
            result.expiredCount += 1;
            return result;
          }

          if (status === 'pending') {
            result.pendingCount += 1;
          } else if (status === 'approved') {
            result.approvedCount += 1;
          } else if (status === 'rejected') {
            result.rejectedCount += 1;
          }

          return result;
        }, {
          pendingCount: 0,
          approvedCount: 0,
          rejectedCount: 0,
          expiredCount: 0,
        });

        return res.json(stats);
      } catch (error) {
        console.error('Failed to load admin job stats', error);
        return res.status(500).json({
          pendingCount: 0,
          approvedCount: 0,
          rejectedCount: 0,
          expiredCount: 0,
        });
      }
    });

    app.patch('/admin/jobs/:jobId/status', requireAuth(['admin']), async (req, res) => {
      try {
        const jobId = toText(req.params.jobId);
        const nextStatus = toText(req.body?.status).toLowerCase();

        if (!jobId || !nextStatus) {
          return res.status(400).json({ message: 'jobId and status are required.' });
        }

        if (!['pending', 'approved', 'rejected'].includes(nextStatus)) {
          return res.status(400).json({ message: 'Invalid job status.' });
        }

        const existingJob = await jobsCollection.findOne({ _id: new ObjectId(jobId) });

        if (!existingJob) {
          return res.status(404).json({ message: 'Job not found.' });
        }

        const updatedJob = {
          ...existingJob,
          status: nextStatus,
          updatedAt: new Date(),
        };

        await jobsCollection.updateOne(
          { _id: new ObjectId(jobId) },
          {
            $set: {
              status: nextStatus,
              updatedAt: new Date(),
            },
          }
        );

        return res.json({
          message: 'Job status updated successfully.',
          job: normalizeJobDocument(updatedJob),
        });
      } catch (error) {
        console.error('Failed to update admin job status', error);
        return res.status(500).json({
          message: 'Something went wrong while updating the job status.',
        });
      }
    });

    app.post('/companies/recruiter/:recruiterId', requireAuth(['recruiter']), requireActiveAccount, async (req, res) => {
      try {
        const recruiterId = toText(req.params.recruiterId);

        if (!recruiterId) {
          return res.status(400).json({ message: 'recruiterId is required.' });
        }

        if (recruiterId !== req.auth.userId) {
          return res.status(403).json({ message: 'You can only create your own companies.' });
        }

        const company = buildCompanyData({
          ...(req.body || {}),
          recruiterId,
        });

        const result = await companiesCollection.insertOne(company);
        const savedCompany = await companiesCollection.findOne({ _id: result.insertedId });

        return res.status(201).json({
          success: true,
          message: 'Company saved successfully.',
          company: normalizeDocument(savedCompany) || company,
        });
      } catch (error) {
        console.error('Failed to save company', error);
        return res.status(500).json({
          message: 'Something went wrong while saving the company.',
        });
      }
    });

    app.patch('/companies/recruiter/:recruiterId/:companyId', requireAuth(['recruiter']), requireActiveAccount, async (req, res) => {
      try {
        const recruiterId = toText(req.params.recruiterId);
        const companyId = toText(req.params.companyId);

        if (!recruiterId || !companyId) {
          return res.status(400).json({ message: 'recruiterId and companyId are required.' });
        }

        if (recruiterId !== req.auth.userId) {
          return res.status(403).json({ message: 'You can only update your own companies.' });
        }

        const existingCompany = await companiesCollection.findOne({ id: companyId });

        if (!existingCompany) {
          return res.status(404).json({ message: 'Company not found.' });
        }

        if (existingCompany.recruiterId && existingCompany.recruiterId !== recruiterId) {
          return res.status(403).json({ message: 'You can only update your own companies.' });
        }

        const company = buildCompanyData({
          ...(req.body || {}),
          id: companyId,
          recruiterId,
          createdAt: existingCompany.createdAt,
        });

        await companiesCollection.updateOne(
          { id: companyId },
          { $set: company }
        );

        const savedCompany = await companiesCollection.findOne({ id: companyId });

        return res.json({
          success: true,
          message: 'Company updated successfully.',
          company: normalizeDocument(savedCompany) || company,
        });
      } catch (error) {
        console.error('Failed to update company', error);
        return res.status(500).json({
          message: 'Something went wrong while updating the company.',
        });
      }
    });

    app.patch('/admin/companies/:companyId/status', requireAuth(['admin']), async (req, res) => {
      try {
        const companyId = toText(req.params.companyId);
        const nextStatus = toText(req.body?.status).toLowerCase();

        if (!companyId || !nextStatus) {
          return res.status(400).json({ message: 'companyId and status are required.' });
        }

        if (!['pending', 'approved', 'rejected'].includes(nextStatus)) {
          return res.status(400).json({ message: 'Invalid company status.' });
        }

        const existingCompany = await companiesCollection.findOne({ id: companyId });

        if (!existingCompany) {
          return res.status(404).json({ message: 'Company not found.' });
        }

        await companiesCollection.updateOne(
          { id: companyId },
          {
            $set: {
              status: nextStatus,
              updatedAt: new Date(),
            },
          }
        );

        const updatedCompany = await companiesCollection.findOne({ id: companyId });
        const companiesWithRecruiterEmail = await attachRecruiterEmail(
          [normalizeDocument(updatedCompany)],
          usersCollection
        );

        return res.json({
          success: true,
          message: 'Company status updated successfully.',
          company: companiesWithRecruiterEmail[0] || normalizeDocument(updatedCompany),
        });
      } catch (error) {
        console.error('Failed to update admin company status', error);
        return res.status(500).json({
          message: 'Something went wrong while updating the company status.',
        });
      }
    });

    app.get('/applications/seeker/:seekerId', requireAuth(['seeker']), async (req, res) => {
      try {
        const seekerId = toText(req.params.seekerId);
        const seekerEmail = toText(req.query.email);

        if (!seekerId) {
          return res.status(400).json({ message: 'seekerId is required.' });
        }

        if (!isSameUser(req.auth, seekerId, seekerEmail)) {
          return res.status(403).json({ message: 'You can only view your own applications.' });
        }

        const filters = buildUserLookupFilters(seekerId);

        if (seekerEmail) {
          filters.push({ 'userInfo.email': seekerEmail });
          filters.push({ 'applicationInfo.email': seekerEmail });
        }

        const applications = await applicationsCollection
          .find({
            $or: filters,
          })
          .sort({ appliedAt: -1, _id: -1 })
          .toArray();

        return res.json(applications);
      } catch (error) {
        console.error('Failed to load applications', error);
        return res.status(500).json([]);
      }
    });

    app.post('/companies', requireAuth(['recruiter']), requireActiveAccount, async (req, res) => {
      const company = buildCompanyData({
        ...(req.body || {}),
        recruiterId: req.auth.userId,
      });
      const result = await companiesCollection.insertOne(company);
      res.send(result);
    });

    console.log('Pinged your deployment. You successfully connected to MongoDB!');
  } finally {
    // Keep the database connection open for the server lifetime.
  }
}

run().catch(console.dir);

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
