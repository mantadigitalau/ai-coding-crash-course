import { Link } from "react-router";
import type { Route } from "./+types/instructor.$courseId.analytics";
import { getCourseById } from "~/services/courseService";
import {
  getCourseAnalytics,
  type CourseMetrics,
  type QuizInsights,
  type RevenueBreakdown,
  type TeamSeats,
} from "~/services/instructorAnalyticsService";
import { getUserById } from "~/services/userService";
import { getCurrentUserId } from "~/lib/session";
import { UserRole } from "~/db/schema";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { StatCard, StatCardSkeleton } from "~/components/stat-card";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  DollarSign,
  GraduationCap,
  Star,
  Ticket,
  Users,
} from "lucide-react";
import { data, isRouteErrorResponse } from "react-router";
import {
  formatQuizScore,
  formatRating,
  formatShare,
  formatUsd,
  plural,
} from "~/lib/utils";

export function meta({ loaderData }: Route.MetaArgs) {
  const title = loaderData?.course?.title ?? "Course Analytics";
  return [
    { title: `Analytics: ${title} — Cadence` },
    { name: "description", content: `Analytics for ${title}` },
  ];
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel to view course analytics.", {
      status: 401,
    });
  }

  const user = getUserById(currentUserId);

  if (!user || (user.role !== UserRole.Instructor && user.role !== UserRole.Admin)) {
    throw data("Only instructors and admins can access this page.", {
      status: 403,
    });
  }

  const courseId = parseInt(params.courseId, 10);
  if (isNaN(courseId)) {
    throw data("Invalid course ID.", { status: 400 });
  }

  const course = getCourseById(courseId);

  if (!course) {
    throw data("Course not found.", { status: 404 });
  }

  if (course.instructorId !== currentUserId && user.role !== UserRole.Admin) {
    throw data("You can only view analytics for your own courses.", {
      status: 403,
    });
  }

  return {
    course: { id: course.id, title: course.title },
    ...getCourseAnalytics(course.id),
  };
}

// ─── Sections ───
// One component per section of getCourseAnalytics. A new section is a new
// component here plus one line in the page body.

function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <p className="text-sm text-muted-foreground">{description}</p>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function HeadlineStats({ headline }: { headline: CourseMetrics }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
      <StatCard
        label="Students"
        icon={Users}
        value={String(headline.students)}
        detail={`+${headline.studentsLast30Days} in last 30 days`}
      />
      <StatCard
        label="Gross revenue (USD)"
        icon={DollarSign}
        value={formatUsd(headline.revenueCents)}
        detail={`+${formatUsd(headline.revenueLast30DaysCents)} in last 30 days`}
      />
      <StatCard
        label="Completion rate"
        icon={CheckCircle2}
        value={formatShare(
          headline.completion.rate,
          headline.completion.completed,
          headline.completion.enrolled
        )}
        detail="Completed ÷ enrolled"
      />
      <StatCard
        label="Avg quiz score"
        icon={GraduationCap}
        value={formatQuizScore(headline.avgQuizScore.average)}
        detail={`First attempts · ${plural(headline.avgQuizScore.count, "attempt")}`}
      />
      <StatCard
        label="Rating"
        icon={Star}
        value={formatRating(headline.rating.average)}
        detail={plural(headline.rating.count, "rating")}
      />
    </div>
  );
}

function SplitRow({
  label,
  cents,
  totalCents,
}: {
  label: string;
  cents: number;
  totalCents: number;
}) {
  const share = totalCents === 0 ? null : cents / totalCents;
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">
        <span className="font-medium">{formatUsd(cents)}</span>
        {share !== null && (
          <span className="ml-2 text-muted-foreground">
            {Math.round(share * 100)}%
          </span>
        )}
      </span>
    </div>
  );
}

function RevenueSection({
  revenue,
  totalCents,
}: {
  revenue: RevenueBreakdown;
  totalCents: number;
}) {
  return (
    <SectionCard
      title="Revenue breakdown"
      description={`Gross revenue (USD) of ${formatUsd(totalCents)}, split two ways`}
    >
      <div className="grid gap-6 sm:grid-cols-2">
        <div className="divide-y divide-border">
          <SplitRow
            label="Individual purchases"
            cents={revenue.individualCents}
            totalCents={totalCents}
          />
          <SplitRow
            label="Team purchases"
            cents={revenue.teamCents}
            totalCents={totalCents}
          />
        </div>
        <div className="divide-y divide-border">
          <SplitRow
            label="Full price"
            cents={revenue.fullPriceCents}
            totalCents={totalCents}
          />
          <SplitRow
            label="PPP discounted"
            cents={revenue.pppCents}
            totalCents={totalCents}
          />
        </div>
      </div>
    </SectionCard>
  );
}

function TeamSeatsSection({ seats }: { seats: TeamSeats }) {
  return (
    <SectionCard
      title="Team seats"
      description="Seats bought through team purchases, and how many have been claimed"
    >
      <div className="flex items-center gap-3">
        <Ticket className="size-5 text-muted-foreground" />
        <p className="text-sm">
          {seats.sold === 0 ? (
            <span className="text-muted-foreground">No team seats sold yet</span>
          ) : (
            <>
              <span className="font-medium tabular-nums">
                {plural(seats.sold, "seat")}
              </span>{" "}
              sold,{" "}
              <span className="font-medium tabular-nums">{seats.redeemed}</span>{" "}
              redeemed
            </>
          )}
        </p>
      </div>
    </SectionCard>
  );
}

function QuizInsightsSection({ insights }: { insights: QuizInsights }) {
  const th =
    "px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground";
  return (
    <SectionCard
      title="Quiz insights"
      description="How students do on each quiz, and the questions they find hardest"
    >
      {insights.quizzes.length === 0 ? (
        <p className="text-sm text-muted-foreground">This course has no quizzes</p>
      ) : (
        <div className="space-y-6">
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className={th}>Quiz</th>
                  <th className={th}>First-attempt avg</th>
                  <th className={th}>First-attempt pass</th>
                  <th className={th}>Eventual pass</th>
                </tr>
              </thead>
              <tbody>
                {insights.quizzes.map((quiz) => (
                  <tr
                    key={quiz.quizId}
                    className="border-b border-border last:border-0"
                  >
                    <td className="px-4 py-3 font-medium">{quiz.title}</td>
                    <td className="px-4 py-3 tabular-nums">
                      {formatQuizScore(quiz.firstAttemptScore.average)}
                      {quiz.firstAttemptScore.count > 0 && (
                        <span className="ml-2 text-muted-foreground">
                          {plural(quiz.firstAttemptScore.count, "student")}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 tabular-nums">
                      {formatShare(
                        quiz.firstAttemptPass.rate,
                        quiz.firstAttemptPass.passed,
                        quiz.firstAttemptPass.attempted
                      )}
                    </td>
                    <td className="px-4 py-3 tabular-nums">
                      {formatShare(
                        quiz.eventualPass.rate,
                        quiz.eventualPass.passed,
                        quiz.eventualPass.attempted
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <h3 className="mb-2 text-sm font-medium">Hardest questions</h3>
            {insights.hardestQuestions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No question has 5 or more answers yet
              </p>
            ) : (
              <ol className="divide-y divide-border">
                {insights.hardestQuestions.map((q) => (
                  <li key={q.questionId} className="py-3 text-sm">
                    <div className="flex items-baseline justify-between gap-4">
                      <div>
                        <p className="text-xs text-muted-foreground">
                          {q.quizTitle}
                        </p>
                        <p className="font-medium">{q.questionText}</p>
                      </div>
                      <span className="shrink-0 tabular-nums">
                        {formatShare(q.correctRate, q.correct, q.answers)}{" "}
                        <span className="text-muted-foreground">correct</span>
                      </span>
                    </div>
                    <p className="mt-1 text-muted-foreground">
                      {plural(q.answers, "answer")} · most common wrong answer:{" "}
                      <span className="text-foreground">
                        {q.mostCommonWrongOption ?? "—"}
                      </span>
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
    </SectionCard>
  );
}

function SectionSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-5 w-40" />
        <Skeleton className="mt-1 h-4 w-72" />
      </CardHeader>
      <CardContent className="space-y-3">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
      </CardContent>
    </Card>
  );
}

export function HydrateFallback() {
  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <Skeleton className="mb-6 h-4 w-64" />
      <div className="mb-8 flex items-center justify-between">
        <div>
          <Skeleton className="h-9 w-72" />
          <Skeleton className="mt-2 h-5 w-48" />
        </div>
        <Skeleton className="h-10 w-36" />
      </div>
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <StatCardSkeleton key={i} />
        ))}
      </div>
      <div className="space-y-6">
        <SectionSkeleton />
        <SectionSkeleton />
        <SectionSkeleton />
      </div>
    </div>
  );
}

export default function CourseAnalytics({ loaderData }: Route.ComponentProps) {
  const { course, headline, revenue, seats } = loaderData;

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/instructor" className="hover:text-foreground">
          My Courses
        </Link>
        <span className="mx-2">/</span>
        <Link to={`/instructor/${course.id}`} className="hover:text-foreground">
          {course.title}
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Analytics</span>
      </nav>

      <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">{course.title}</h1>
          <p className="mt-1 text-muted-foreground">Course analytics</p>
        </div>
        <Link to={`/instructor/${course.id}/students`}>
          <Button variant="outline">
            <Users className="mr-2 size-4" />
            View students
          </Button>
        </Link>
      </div>

      <div className="space-y-6">
        <HeadlineStats headline={headline} />
        <RevenueSection revenue={revenue} totalCents={headline.revenueCents} />
        <TeamSeatsSection seats={seats} />
        <QuizInsightsSection insights={loaderData.quizInsights} />
      </div>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading course analytics.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message = typeof error.data === "string" ? error.data : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Access denied";
      message = typeof error.data === "string" ? error.data : "You don't have permission to access this page.";
    } else if (error.status === 404) {
      title = "Not found";
      message = typeof error.data === "string" ? error.data : "The course you're looking for doesn't exist.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <Link to="/instructor">
          <Button variant="outline">
            <ArrowLeft className="mr-2 size-4" />
            Back to My Courses
          </Button>
        </Link>
      </div>
    </div>
  );
}
