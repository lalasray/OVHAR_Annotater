import cv2
import mediapipe as mp
import pandas as pd
import argparse
import os
from ultralytics import YOLO

def main(input_path, output_video, output_csv, det_conf=0.5):

    # Load YOLO model for person detection (downloads weights on first run)
    yolo_model = YOLO("yolov8n.pt")  # small and fast

    mp_pose = mp.solutions.pose
    mp_drawing = mp.solutions.drawing_utils

    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        print(f"Could not open video: {input_path}")
        return

    fps = cap.get(cv2.CAP_PROP_FPS) or 25
    width  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out = cv2.VideoWriter(output_video, fourcc, fps, (width, height))

    all_rows = []  # 3D landmarks from all persons
    frame_idx = 0

    with mp_pose.Pose(
        static_image_mode=False,
        model_complexity=1,
        enable_segmentation=False,
        min_detection_confidence=0.5,
        min_tracking_confidence=0.5
    ) as pose:

        while True:
            success, frame = cap.read()
            if not success:
                break

            orig_h, orig_w = frame.shape[:2]

            # --- 1) Detect people with YOLO ---
            # NOTE: results are in image coordinates
            det_results = yolo_model(frame, verbose=False)[0]

            # Filter for class 'person' (COCO id = 0)
            person_boxes = []
            for box in det_results.boxes:
                cls = int(box.cls[0].item())
                conf = float(box.conf[0].item())
                if cls == 0 and conf >= det_conf:
                    x1, y1, x2, y2 = box.xyxy[0].tolist()
                    x1, y1, x2, y2 = map(int, [x1, y1, x2, y2])
                    person_boxes.append((x1, y1, x2, y2, conf))

            # --- 2) Run MediaPipe Pose on each person crop ---
            person_id = 0
            for (x1, y1, x2, y2, conf) in person_boxes:
                # Clamp box to frame
                x1 = max(0, x1)
                y1 = max(0, y1)
                x2 = min(orig_w - 1, x2)
                y2 = min(orig_h - 1, y2)
                if x2 <= x1 or y2 <= y1:
                    continue

                person_roi = frame[y1:y2, x1:x2]

                # BGR -> RGB
                image_rgb = cv2.cvtColor(person_roi, cv2.COLOR_BGR2RGB)
                image_rgb.flags.writeable = False
                results = pose.process(image_rgb)
                image_rgb.flags.writeable = True

                if not results.pose_landmarks or not results.pose_world_landmarks:
                    person_id += 1
                    continue

                # --- 3) Draw pose back on original frame ---
                # Draw on the ROI then paste back
                output_roi = person_roi.copy()
                mp_drawing.draw_landmarks(
                    output_roi,
                    results.pose_landmarks,
                    mp_pose.POSE_CONNECTIONS
                )
                frame[y1:y2, x1:x2] = output_roi

                # Optional: draw box + ID
                cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 255), 2)
                cv2.putText(frame, f"ID {person_id}", (x1, max(0, y1 - 10)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2)

                # --- 4) Save 3D landmarks (world coords) with a person_id ---
                frame_time = frame_idx / fps
                for lm_id, lm in enumerate(results.pose_world_landmarks.landmark):
                    all_rows.append({
                        "frame": frame_idx,
                        "time_s": frame_time,
                        "person_id": person_id,
                        "landmark_id": lm_id,
                        "x_m": lm.x,
                        "y_m": lm.y,
                        "z_m": lm.z,
                        "visibility": lm.visibility
                    })

                person_id += 1

            # --- 5) Annotate frame-level info & write output video ---
            cv2.putText(frame, f"Frame: {frame_idx}", (20, 40),
                        cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 0), 2)
            cv2.putText(frame, f"Persons: {len(person_boxes)}", (20, 80),
                        cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 255), 2)

            out.write(frame)

            # Optional live preview
            cv2.imshow("Multi-person Pose", frame)
            if cv2.waitKey(1) & 0xFF == 27:  # ESC
                break

            frame_idx += 1

    cap.release()
    out.release()
    cv2.destroyAllWindows()

    # Save landmarks
    df = pd.DataFrame(all_rows)
    df.to_csv(output_csv, index=False)

    print(f"Annotated multi-person video saved to: {os.path.abspath(output_video)}")
    print(f"3D multi-person CSV saved to       : {os.path.abspath(output_csv)}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Multi-person 3D pose from video (YOLO + MediaPipe)")
    parser.add_argument("--input", "-i", type=str, default="input.mp4",
                        help="Input video path")
    parser.add_argument("--out_video", "-ov", type=str, default="output_multi_pose.mp4",
                        help="Output annotated video path")
    parser.add_argument("--out_csv", "-oc", type=str, default="multi_pose3d_output.csv",
                        help="Output CSV path")
    parser.add_argument("--det_conf", "-dc", type=float, default=0.5,
                        help="Detection confidence threshold for YOLO")
    args = parser.parse_args()

    main(args.input, args.out_video, args.out_csv, det_conf=args.det_conf)
