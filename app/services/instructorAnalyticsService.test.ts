import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { eq } from "drizzle-orm";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

// Import after mock so the module picks up our test db
import {
  getCourseAnalytics,
  getInstructorDashboard,
} from "./instructorAnalyticsService";

const NOW = new Date("2026-06-01T12:00:00.000Z");

function daysBefore(days: number) {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

let emailCounter = 0;

function createStudent() {
  emailCounter++;
  return testDb
    .insert(schema.users)
    .values({
      name: `Student ${emailCounter}`,
      email: `student${emailCounter}@example.com`,
      role: schema.UserRole.Student,
    })
    .returning()
    .get();
}

function createInstructor() {
  emailCounter++;
  return testDb
    .insert(schema.users)
    .values({
      name: `Instructor ${emailCounter}`,
      email: `instructor${emailCounter}@example.com`,
      role: schema.UserRole.Instructor,
    })
    .returning()
    .get();
}

function createCourse(
  title: string,
  instructorId: number = base.instructor.id,
  status: schema.CourseStatus = schema.CourseStatus.Published
) {
  return testDb
    .insert(schema.courses)
    .values({
      title,
      slug: title.toLowerCase().replace(/\s+/g, "-"),
      description: "A course",
      salesCopy: "Sales copy.",
      instructorId,
      categoryId: base.category.id,
      status,
    })
    .returning()
    .get();
}

function enroll(
  userId: number,
  courseId: number,
  enrolledAt: string = daysBefore(60),
  completedAt: string | null = null
) {
  return testDb
    .insert(schema.enrollments)
    .values({ userId, courseId, enrolledAt, completedAt })
    .returning()
    .get();
}

function purchase(
  userId: number,
  courseId: number,
  amountPaid: number,
  createdAt: string = daysBefore(60),
  country: string | null = null
) {
  return testDb
    .insert(schema.purchases)
    .values({ userId, courseId, amountPaid, createdAt, country })
    .returning()
    .get();
}

let couponCounter = 0;

/** A team purchase: one purchase row plus a coupon per seat. */
function teamPurchase(
  buyerId: number,
  courseId: number,
  amountPaid: number,
  seats: number,
  redeemedBy: number[] = [],
  country: string | null = null
) {
  const team = testDb.insert(schema.teams).values({}).returning().get();
  const row = purchase(buyerId, courseId, amountPaid, daysBefore(20), country);
  for (let i = 0; i < seats; i++) {
    couponCounter++;
    const redeemer = redeemedBy[i] ?? null;
    testDb
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId,
        code: `SEAT-${couponCounter}`,
        purchaseId: row.id,
        redeemedByUserId: redeemer,
        redeemedAt: redeemer === null ? null : daysBefore(10),
      })
      .run();
  }
  return row;
}

function createQuiz(courseId: number, title = "Quiz", position = 1) {
  const mod = testDb
    .insert(schema.modules)
    .values({ courseId, title: "Module", position })
    .returning()
    .get();
  const lesson = testDb
    .insert(schema.lessons)
    .values({ moduleId: mod.id, title: "Lesson", position: 1 })
    .returning()
    .get();
  return testDb
    .insert(schema.quizzes)
    .values({ lessonId: lesson.id, title, passingScore: 0.7 })
    .returning()
    .get();
}

function attempt(
  userId: number,
  quizId: number,
  score: number,
  attemptedAt: string
) {
  return testDb
    .insert(schema.quizAttempts)
    .values({ userId, quizId, score, passed: score > 0.7, attemptedAt })
    .returning()
    .get();
}

/** A single-choice question; returns the question and its options in order. */
function createQuestion(quizId: number, text: string, optionTexts: string[], correctIndex = 0) {
  const question = testDb
    .insert(schema.quizQuestions)
    .values({
      quizId,
      questionText: text,
      questionType: schema.QuestionType.MultipleChoice,
      position: 1,
    })
    .returning()
    .get();
  const options = optionTexts.map((optionText, i) =>
    testDb
      .insert(schema.quizOptions)
      .values({ questionId: question.id, optionText, isCorrect: i === correctIndex })
      .returning()
      .get()
  );
  return { question, options };
}

/**
 * Records one answer per selected option, each in its own attempt by a new
 * student. `selections` lists option indexes.
 */
function answerMany(
  quizId: number,
  q: ReturnType<typeof createQuestion>,
  selections: number[]
) {
  for (const index of selections) {
    const a = attempt(createStudent().id, quizId, 0.5, daysBefore(3));
    testDb
      .insert(schema.quizAnswers)
      .values({
        attemptId: a.id,
        questionId: q.question.id,
        selectedOptionId: q.options[index].id,
      })
      .run();
  }
}

function rate(userId: number, courseId: number, rating: number) {
  return testDb
    .insert(schema.courseRatings)
    .values({ userId, courseId, rating })
    .returning()
    .get();
}

function rowFor(
  dashboard: ReturnType<typeof getInstructorDashboard>,
  courseId: number
) {
  const row = dashboard.courses.find((c) => c.id === courseId);
  if (!row) throw new Error(`No row for course ${courseId}`);
  return row;
}

describe("instructorAnalyticsService", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  describe("getInstructorDashboard", () => {
    it("lists every course the instructor owns, of every status", () => {
      const draft = createCourse("Draft Course", base.instructor.id, schema.CourseStatus.Draft);
      const archived = createCourse(
        "Archived Course",
        base.instructor.id,
        schema.CourseStatus.Archived
      );

      const dashboard = getInstructorDashboard(base.instructor.id, NOW);

      expect(
        dashboard.courses.map((c) => ({ id: c.id, status: c.status })).sort((a, b) => a.id - b.id)
      ).toEqual([
        { id: base.course.id, status: schema.CourseStatus.Published },
        { id: draft.id, status: schema.CourseStatus.Draft },
        { id: archived.id, status: schema.CourseStatus.Archived },
      ]);
    });

    it("never includes another instructor's courses or numbers", () => {
      const other = createInstructor();
      const otherCourse = createCourse("Other Course", other.id);
      const student = createStudent();
      enroll(student.id, otherCourse.id, daysBefore(5), daysBefore(1));
      purchase(student.id, otherCourse.id, 5000, daysBefore(5));
      rate(student.id, otherCourse.id, 5);
      const quiz = createQuiz(otherCourse.id);
      attempt(student.id, quiz.id, 0.9, daysBefore(2));

      const dashboard = getInstructorDashboard(base.instructor.id, NOW);

      expect(dashboard.courses.map((c) => c.id)).toEqual([base.course.id]);
      expect(dashboard.totals).toEqual({
        students: 0,
        studentsLast30Days: 0,
        revenueCents: 0,
        revenueLast30DaysCents: 0,
        completion: { rate: null, completed: 0, enrolled: 0 },
        avgQuizScore: { average: null, count: 0 },
        rating: { average: null, count: 0 },
      });
    });

    it("counts enrolled students and those enrolled in the last 30 days", () => {
      const second = createCourse("Second Course");
      enroll(createStudent().id, base.course.id, daysBefore(45));
      enroll(createStudent().id, base.course.id, daysBefore(10));
      enroll(createStudent().id, second.id, daysBefore(29));
      enroll(createStudent().id, second.id, daysBefore(31));
      enroll(createStudent().id, second.id, daysBefore(90));

      const dashboard = getInstructorDashboard(base.instructor.id, NOW);

      expect(dashboard.totals.students).toBe(5);
      expect(dashboard.totals.studentsLast30Days).toBe(2);
      expect(rowFor(dashboard, base.course.id).students).toBe(2);
      expect(rowFor(dashboard, base.course.id).studentsLast30Days).toBe(1);
      expect(rowFor(dashboard, second.id).students).toBe(3);
      expect(rowFor(dashboard, second.id).studentsLast30Days).toBe(1);
    });

    it("sums gross revenue and revenue from the last 30 days", () => {
      const second = createCourse("Second Course");
      const buyer = createStudent();
      purchase(buyer.id, base.course.id, 4999, daysBefore(80));
      purchase(buyer.id, base.course.id, 2500, daysBefore(3));
      // A team purchase is one row whose amount covers every seat.
      purchase(buyer.id, second.id, 15000, daysBefore(12));
      purchase(buyer.id, second.id, 1000, daysBefore(31));

      const dashboard = getInstructorDashboard(base.instructor.id, NOW);

      expect(dashboard.totals.revenueCents).toBe(23499);
      expect(dashboard.totals.revenueLast30DaysCents).toBe(17500);
      expect(rowFor(dashboard, base.course.id).revenueCents).toBe(7499);
      expect(rowFor(dashboard, second.id).revenueCents).toBe(16000);
      expect(rowFor(dashboard, second.id).revenueLast30DaysCents).toBe(15000);
    });

    it("reports completion as completed ÷ enrolled, null with no enrollments", () => {
      const second = createCourse("Second Course");
      const empty = createCourse("Empty Course");
      enroll(createStudent().id, base.course.id, daysBefore(40), daysBefore(5));
      enroll(createStudent().id, base.course.id, daysBefore(40));
      enroll(createStudent().id, base.course.id, daysBefore(40));
      enroll(createStudent().id, second.id, daysBefore(40), daysBefore(2));

      const dashboard = getInstructorDashboard(base.instructor.id, NOW);

      expect(rowFor(dashboard, base.course.id).completion).toEqual({
        rate: 1 / 3,
        completed: 1,
        enrolled: 3,
      });
      expect(rowFor(dashboard, empty.id).completion).toEqual({
        rate: null,
        completed: 0,
        enrolled: 0,
      });
      expect(dashboard.totals.completion).toEqual({
        rate: 0.5,
        completed: 2,
        enrolled: 4,
      });
    });

    it("averages each student's first attempt per quiz, ignoring retakes", () => {
      const second = createCourse("Second Course");
      const quizA = createQuiz(base.course.id);
      const quizB = createQuiz(second.id);
      const alice = createStudent();
      const bob = createStudent();

      // Alice retakes quiz A: only the 0.4 counts. Insert the retake first to
      // prove ordering is by attempt date, not insertion order.
      attempt(alice.id, quizA.id, 1.0, daysBefore(5));
      attempt(alice.id, quizA.id, 0.4, daysBefore(10));
      // Two attempts at the same instant: the earlier row wins.
      attempt(bob.id, quizA.id, 0.6, daysBefore(8));
      attempt(bob.id, quizA.id, 0.9, daysBefore(8));
      attempt(bob.id, quizB.id, 0.8, daysBefore(4));

      const dashboard = getInstructorDashboard(base.instructor.id, NOW);

      const rowA = rowFor(dashboard, base.course.id).avgQuizScore;
      expect(rowA.count).toBe(2);
      expect(rowA.average).toBeCloseTo(0.5);
      expect(rowFor(dashboard, second.id).avgQuizScore).toEqual({
        average: 0.8,
        count: 1,
      });
      // Pooled over all three student × quiz first attempts.
      expect(dashboard.totals.avgQuizScore.count).toBe(3);
      expect(dashboard.totals.avgQuizScore.average).toBeCloseTo(0.6);
    });

    it("reports average rating with its count, pooled across courses", () => {
      const second = createCourse("Second Course");
      const unrated = createCourse("Unrated Course");
      rate(createStudent().id, base.course.id, 5);
      rate(createStudent().id, base.course.id, 4);
      rate(createStudent().id, second.id, 2);

      const dashboard = getInstructorDashboard(base.instructor.id, NOW);

      expect(rowFor(dashboard, base.course.id).rating).toEqual({
        average: 4.5,
        count: 2,
      });
      expect(rowFor(dashboard, unrated.id).rating).toEqual({
        average: null,
        count: 0,
      });
      // (5 + 4 + 2) / 3 = 3.67, not the 3.25 average of course averages.
      expect(dashboard.totals.rating).toEqual({ average: 3.7, count: 3 });
    });
  });
  describe("getCourseAnalytics", () => {
    it("reports the same headline stats as the course's dashboard row", () => {
      const other = createCourse("Other Course");
      const alice = createStudent();
      const bob = createStudent();
      enroll(alice.id, base.course.id, daysBefore(40), daysBefore(5));
      enroll(bob.id, base.course.id, daysBefore(10));
      enroll(bob.id, other.id, daysBefore(10));
      purchase(alice.id, base.course.id, 4999, daysBefore(40));
      purchase(bob.id, base.course.id, 2500, daysBefore(10));
      purchase(bob.id, other.id, 9999, daysBefore(10));
      const quiz = createQuiz(base.course.id);
      attempt(alice.id, quiz.id, 0.5, daysBefore(9));
      attempt(alice.id, quiz.id, 1.0, daysBefore(8));
      attempt(bob.id, quiz.id, 0.9, daysBefore(7));
      rate(alice.id, base.course.id, 4);
      rate(bob.id, other.id, 1);

      const analytics = getCourseAnalytics(base.course.id, NOW);

      expect(analytics.headline).toEqual({
        students: 2,
        studentsLast30Days: 1,
        revenueCents: 7499,
        revenueLast30DaysCents: 2500,
        completion: { rate: 0.5, completed: 1, enrolled: 2 },
        avgQuizScore: { average: 0.7, count: 2 },
        rating: { average: 4, count: 1 },
      });
      const { id: _id, title: _t, slug: _s, status: _st, ...row } = rowFor(
        getInstructorDashboard(base.instructor.id, NOW),
        base.course.id
      );
      expect(analytics.headline).toEqual(row);
    });

    it("splits revenue into individual and team purchases", () => {
      const buyer = createStudent();
      purchase(buyer.id, base.course.id, 4999);
      purchase(createStudent().id, base.course.id, 2500);
      teamPurchase(buyer.id, base.course.id, 15000, 3);
      // Another course's team purchase doesn't count here.
      teamPurchase(buyer.id, createCourse("Other Course").id, 80000, 2);

      const { revenue } = getCourseAnalytics(base.course.id, NOW);

      expect(revenue.individualCents).toBe(7499);
      expect(revenue.teamCents).toBe(15000);
    });

    it("splits revenue into full price and PPP by purchase country", () => {
      const buyer = createStudent();
      purchase(buyer.id, base.course.id, 4999, daysBefore(5), "US");
      purchase(buyer.id, base.course.id, 3000, daysBefore(5), null);
      purchase(buyer.id, base.course.id, 2500, daysBefore(5), "IN");
      purchase(buyer.id, base.course.id, 1500, daysBefore(5), "ng");
      teamPurchase(buyer.id, base.course.id, 10000, 2, [], "BR");

      const { revenue, headline } = getCourseAnalytics(base.course.id, NOW);

      expect(revenue.fullPriceCents).toBe(7999);
      expect(revenue.pppCents).toBe(14000);
      expect(revenue.fullPriceCents + revenue.pppCents).toBe(
        headline.revenueCents
      );
      expect(revenue.individualCents + revenue.teamCents).toBe(
        headline.revenueCents
      );
    });

    it("counts every purchase as full price when the course has PPP disabled", () => {
      const course = testDb
        .update(schema.courses)
        .set({ pppEnabled: false })
        .where(eq(schema.courses.id, base.course.id))
        .returning()
        .get();
      const buyer = createStudent();
      purchase(buyer.id, course.id, 4999, daysBefore(5), "IN");
      purchase(buyer.id, course.id, 4999, daysBefore(5), "US");

      const { revenue } = getCourseAnalytics(course.id, NOW);

      expect(revenue.fullPriceCents).toBe(9998);
      expect(revenue.pppCents).toBe(0);
    });

    it("counts team seats sold and redeemed, without counting seats as students", () => {
      const buyer = createStudent();
      const alice = createStudent();
      const bob = createStudent();
      teamPurchase(buyer.id, base.course.id, 15000, 3, [alice.id]);
      teamPurchase(buyer.id, base.course.id, 10000, 2, [bob.id]);
      enroll(alice.id, base.course.id);
      enroll(bob.id, base.course.id);
      teamPurchase(buyer.id, createCourse("Other Course").id, 5000, 4, [alice.id]);

      const { seats, headline } = getCourseAnalytics(base.course.id, NOW);

      expect(seats).toEqual({ sold: 5, redeemed: 2 });
      expect(headline.students).toBe(2);
    });

    it("reports zero seats when there are no team purchases", () => {
      purchase(createStudent().id, base.course.id, 4999);

      expect(getCourseAnalytics(base.course.id, NOW).seats).toEqual({
        sold: 0,
        redeemed: 0,
      });
    });
  });
  describe("getCourseAnalytics quiz insights", () => {
    it("reports first-attempt average and pass rate, and eventual pass rate, per quiz", () => {
      const quiz = createQuiz(base.course.id, "Basics Quiz");
      const alice = createStudent();
      const bob = createStudent();
      const carol = createStudent();

      // Alice fails, then passes on a retake (retake inserted first).
      attempt(alice.id, quiz.id, 0.9, daysBefore(5));
      attempt(alice.id, quiz.id, 0.5, daysBefore(10));
      // Bob passes first time.
      attempt(bob.id, quiz.id, 0.8, daysBefore(8));
      // Carol fails twice.
      attempt(carol.id, quiz.id, 0.2, daysBefore(9));
      attempt(carol.id, quiz.id, 0.6, daysBefore(7));

      const [stats] = getCourseAnalytics(base.course.id, NOW).quizInsights.quizzes;

      expect(stats.title).toBe("Basics Quiz");
      expect(stats.firstAttemptScore.count).toBe(3);
      expect(stats.firstAttemptScore.average).toBeCloseTo(0.5);
      expect(stats.firstAttemptPass).toEqual({ rate: 1 / 3, passed: 1, attempted: 3 });
      expect(stats.eventualPass).toEqual({ rate: 2 / 3, passed: 2, attempted: 3 });
    });

    it("lists quizzes with no attempts with null rates, in course order", () => {
      const later = createQuiz(base.course.id, "Later Quiz", 2);
      const earlier = createQuiz(base.course.id, "Earlier Quiz", 1);
      attempt(createStudent().id, earlier.id, 0.8, daysBefore(3));
      createQuiz(createCourse("Other Course").id, "Other Quiz");

      const { quizzes } = getCourseAnalytics(base.course.id, NOW).quizInsights;

      expect(quizzes.map((q) => q.quizId)).toEqual([earlier.id, later.id]);
      expect(quizzes[1]).toMatchObject({
        firstAttemptScore: { average: null, count: 0 },
        firstAttemptPass: { rate: null, passed: 0, attempted: 0 },
        eventualPass: { rate: null, passed: 0, attempted: 0 },
      });
    });
    it("leaves out questions with fewer than 5 answers", () => {
      const quiz = createQuiz(base.course.id, "Basics Quiz");
      const sparse = createQuestion(quiz.id, "Sparse?", ["Right", "Wrong"]);
      const enough = createQuestion(quiz.id, "Enough?", ["Right", "Wrong"]);
      answerMany(quiz.id, sparse, [1, 1, 1, 1]);
      answerMany(quiz.id, enough, [0, 0, 0, 1, 1]);

      const { hardestQuestions } = getCourseAnalytics(base.course.id, NOW).quizInsights;

      expect(hardestQuestions).toEqual([
        {
          questionId: enough.question.id,
          quizTitle: "Basics Quiz",
          questionText: "Enough?",
          correctRate: 0.6,
          correct: 3,
          answers: 5,
          mostCommonWrongOption: "Wrong",
        },
      ]);
    });
    it("ranks the 3 questions with the lowest % correct across the course's quizzes", () => {
      const quizA = createQuiz(base.course.id, "Quiz A", 1);
      const quizB = createQuiz(base.course.id, "Quiz B", 2);
      const easy = createQuestion(quizA.id, "Easy", ["R", "W"]);
      const hardest = createQuestion(quizB.id, "Hardest", ["R", "W"]);
      const hard = createQuestion(quizA.id, "Hard", ["R", "W"]);
      const middling = createQuestion(quizB.id, "Middling", ["R", "W"]);
      answerMany(quizA.id, easy, [0, 0, 0, 0, 0]); // 100%
      answerMany(quizB.id, hardest, [1, 1, 1, 1, 0]); // 20%
      answerMany(quizA.id, hard, [0, 1, 1, 1, 0, 1]); // 33%
      answerMany(quizB.id, middling, [0, 0, 0, 1, 1]); // 60%

      // A harder question in another course never appears.
      const otherQuiz = createQuiz(createCourse("Other Course").id);
      answerMany(otherQuiz.id, createQuestion(otherQuiz.id, "Other", ["R", "W"]), [1, 1, 1, 1, 1]);

      const { hardestQuestions } = getCourseAnalytics(base.course.id, NOW).quizInsights;

      expect(
        hardestQuestions.map((q) => [q.questionText, q.quizTitle, q.correct, q.answers])
      ).toEqual([
        ["Hardest", "Quiz B", 1, 5],
        ["Hard", "Quiz A", 2, 6],
        ["Middling", "Quiz B", 3, 5],
      ]);
    });

    it("names the wrong option chosen most often, and null when every answer was right", () => {
      const quiz = createQuiz(base.course.id);
      const split = createQuestion(quiz.id, "Split", ["Right", "Wrong A", "Wrong B", "Wrong C"]);
      const tied = createQuestion(quiz.id, "Tied", ["Right", "Wrong A", "Wrong B"]);
      const allRight = createQuestion(quiz.id, "All right", ["Right", "Wrong"]);
      // Correct is the most-chosen option overall, but only wrong ones count.
      answerMany(quiz.id, split, [0, 0, 0, 0, 1, 2, 2, 3]);
      // Equal counts: the option listed first wins.
      answerMany(quiz.id, tied, [0, 2, 1, 2, 1]);
      answerMany(quiz.id, allRight, [0, 0, 0, 0, 0]);

      const byText = new Map(
        getCourseAnalytics(base.course.id, NOW).quizInsights.hardestQuestions.map(
          (q) => [q.questionText, q.mostCommonWrongOption]
        )
      );

      expect(byText.get("Split")).toBe("Wrong B");
      expect(byText.get("Tied")).toBe("Wrong A");
      expect(byText.get("All right")).toBeNull();
    });
  });
});
