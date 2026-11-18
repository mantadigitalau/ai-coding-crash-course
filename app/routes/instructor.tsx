import { Link } from "react-router";
import type { Route } from "./+types/instructor";
import { getInstructorDashboard } from "~/services/instructorAnalyticsService";
import { getCurrentUserId } from "~/lib/session";
import { getUserById } from "~/services/userService";
import { Card, CardContent } from "~/components/ui/card";
import { StatCard, StatCardSkeleton } from "~/components/stat-card";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  DollarSign,
  GraduationCap,
  Pencil,
  Plus,
  Star,
  Users,
} from "lucide-react";
import { data, isRouteErrorResponse } from "react-router";
import { CourseStatus, UserRole } from "~/db/schema";
import {
  formatQuizScore,
  formatRating,
  formatShare,
  formatUsd,
  plural,
} from "~/lib/utils";

export function meta() {
  return [
    { title: "My Courses — Cadence" },
    { name: "description", content: "Manage your courses" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel to view your courses.", {
      status: 401,
    });
  }

  const user = getUserById(currentUserId);

  if (!user || user.role !== UserRole.Instructor) {
    throw data("Only instructors can access this page.", {
      status: 403,
    });
  }

  return getInstructorDashboard(currentUserId);
}

function statusBadge(status: string) {
  switch (status) {
    case CourseStatus.Published:
      return (
        <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/30 dark:text-green-400">
          Published
        </span>
      );
    case CourseStatus.Draft:
      return (
        <span className="inline-flex items-center rounded-full bg-yellow-100 px-2.5 py-0.5 text-xs font-medium text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400">
          Draft
        </span>
      );
    case CourseStatus.Archived:
      return (
        <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-800 dark:bg-gray-900/30 dark:text-gray-400">
          Archived
        </span>
      );
    default:
      return null;
  }
}

const TH_CLASS =
  "px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground";

const COLUMNS = [
  "Course",
  "Students",
  "Revenue",
  "Completion",
  "Avg quiz score",
  "Rating",
  "Actions",
];

function TableRowSkeleton() {
  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-4 py-3"><Skeleton className="h-4 w-48" /></td>
      <td className="px-4 py-3"><Skeleton className="h-4 w-10" /></td>
      <td className="px-4 py-3"><Skeleton className="h-4 w-20" /></td>
      <td className="px-4 py-3"><Skeleton className="h-4 w-24" /></td>
      <td className="px-4 py-3"><Skeleton className="h-4 w-16" /></td>
      <td className="px-4 py-3"><Skeleton className="h-4 w-16" /></td>
      <td className="px-4 py-3"><Skeleton className="h-8 w-40" /></td>
    </tr>
  );
}

function CourseTableHead() {
  return (
    <thead>
      <tr className="border-b border-border bg-muted/50">
        {COLUMNS.map((column) => (
          <th key={column} className={TH_CLASS}>
            {column}
          </th>
        ))}
      </tr>
    </thead>
  );
}

export function HydrateFallback() {
  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <Skeleton className="h-9 w-40" />
          <Skeleton className="mt-2 h-5 w-72" />
        </div>
        <Skeleton className="h-10 w-32" />
      </div>
      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <StatCardSkeleton key={i} />
        ))}
      </div>
      <Card className="py-0">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <CourseTableHead />
              <tbody>
                {Array.from({ length: 4 }).map((_, i) => (
                  <TableRowSkeleton key={i} />
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function InstructorDashboard({
  loaderData,
}: Route.ComponentProps) {
  const { totals, courses } = loaderData;

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      {/* Breadcrumb */}
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">My Courses</span>
      </nav>

      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">My Courses</h1>
          <p className="mt-1 text-muted-foreground">
            How your courses are doing, across every course you own
          </p>
        </div>
        <Link to="/instructor/new">
          <Button>
            <Plus className="mr-2 size-4" />
            New Course
          </Button>
        </Link>
      </div>

      {courses.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <GraduationCap className="mb-4 size-12 text-muted-foreground/50" />
          <h2 className="text-lg font-medium">No courses yet</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Create your first course to get started.
          </p>
          <Link to="/instructor/new" className="mt-4">
            <Button>
              <Plus className="mr-2 size-4" />
              Create Course
            </Button>
          </Link>
        </div>
      ) : (
        <>
          <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <StatCard
              label="Students"
              icon={Users}
              value={String(totals.students)}
              detail={`+${totals.studentsLast30Days} in last 30 days`}
            />
            <StatCard
              label="Gross revenue (USD)"
              icon={DollarSign}
              value={formatUsd(totals.revenueCents)}
              detail={`+${formatUsd(totals.revenueLast30DaysCents)} in last 30 days`}
            />
            <StatCard
              label="Completion rate"
              icon={CheckCircle2}
              value={formatShare(
                totals.completion.rate,
                totals.completion.completed,
                totals.completion.enrolled
              )}
              detail="Completed ÷ enrolled"
            />
            <StatCard
              label="Avg quiz score"
              icon={GraduationCap}
              value={formatQuizScore(totals.avgQuizScore.average)}
              detail={`First attempts · ${plural(totals.avgQuizScore.count, "attempt")}`}
            />
            <StatCard
              label="Avg rating"
              icon={Star}
              value={formatRating(totals.rating.average)}
              detail={plural(totals.rating.count, "rating")}
            />
          </div>

          <Card className="py-0">
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <CourseTableHead />
                  <tbody>
                    {courses.map((course) => (
                      <tr
                        key={course.id}
                        className="border-b border-border last:border-0"
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <Link
                              to={`/courses/${course.slug}`}
                              className="font-medium hover:text-primary"
                            >
                              {course.title}
                            </Link>
                            {statusBadge(course.status)}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm tabular-nums">
                          {course.students}
                        </td>
                        <td className="px-4 py-3 text-sm tabular-nums">
                          {formatUsd(course.revenueCents)}
                        </td>
                        <td className="px-4 py-3 text-sm tabular-nums">
                          {formatShare(
                            course.completion.rate,
                            course.completion.completed,
                            course.completion.enrolled
                          )}
                        </td>
                        <td className="px-4 py-3 text-sm tabular-nums">
                          {formatQuizScore(course.avgQuizScore.average)}
                          {course.avgQuizScore.average !== null && (
                            <span className="text-muted-foreground">
                              {" "}
                              · {plural(course.avgQuizScore.count, "attempt")}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-sm tabular-nums">
                          {formatRating(course.rating.average)}
                          {course.rating.average !== null && (
                            <span className="text-muted-foreground">
                              {" "}
                              · {plural(course.rating.count, "rating")}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <Link to={`/instructor/${course.id}`}>
                              <Button size="sm" variant="outline">
                                <Pencil className="mr-1.5 size-3.5" />
                                Edit
                              </Button>
                            </Link>
                            <Link to={`/instructor/${course.id}/analytics`}>
                              <Button size="sm" variant="ghost">
                                <BarChart3 className="mr-1.5 size-3.5" />
                                Analytics
                              </Button>
                            </Link>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading your courses.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message = typeof error.data === "string" ? error.data : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Access denied";
      message = typeof error.data === "string" ? error.data : "You don't have permission to access this page.";
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
        <div className="flex items-center justify-center gap-3">
          <Link to="/courses">
            <Button variant="outline">Browse Courses</Button>
          </Link>
          <Link to="/">
            <Button>Go Home</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
