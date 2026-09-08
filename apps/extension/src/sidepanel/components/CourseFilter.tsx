import type { Course } from "@nova-agent/core";
import { Check, ChevronDown } from "lucide-react";
import { Select } from "radix-ui";
import type { CourseFilter as CourseFilterValue } from "../model";
import { courseSwatch } from "../theme";

const ALL = "__all__";

export type CourseFilterProps = { courses: Course[]; value: CourseFilterValue; onChange: (value: CourseFilterValue) => void };

export const CourseFilter = ({ courses, value, onChange }: CourseFilterProps) => (
  <Select.Root value={value ?? ALL} onValueChange={(next) => onChange(next === ALL ? null : next)}>
    <Select.Trigger className="select-trigger" aria-label="Filter by course">
      <Select.Value placeholder="All courses" />
      <Select.Icon>
        <ChevronDown size={14} aria-hidden="true" />
      </Select.Icon>
    </Select.Trigger>
    <Select.Portal>
      <Select.Content className="select-content" position="popper" sideOffset={6} collisionPadding={8}>
        <Select.Viewport>
          <Select.Item className="select-item" value={ALL}>
            <Select.ItemText>All courses</Select.ItemText>
            <Select.ItemIndicator>
              <Check size={14} aria-hidden="true" />
            </Select.ItemIndicator>
          </Select.Item>
          {courses.map((course) => (
            <Select.Item className="select-item" value={course.id} key={course.id}>
              <span className="course-dot" style={{ background: courseSwatch(course.color) }} aria-hidden="true" />
              <Select.ItemText>{course.name}</Select.ItemText>
              <Select.ItemIndicator>
                <Check size={14} aria-hidden="true" />
              </Select.ItemIndicator>
            </Select.Item>
          ))}
        </Select.Viewport>
      </Select.Content>
    </Select.Portal>
  </Select.Root>
);
